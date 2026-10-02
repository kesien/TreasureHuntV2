import { and, eq, sql } from "drizzle-orm";
import { distanceMeters, locationsRevealed, type EventStatus, type PickupMode } from "@th/shared";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/client.js";
import { events, hosts, stations, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { enqueueEmail } from "./outbox.js";

export const PROXIMITY_M = 25;

/** Következő állomásszám; az esemény számlálója sosem csökken, így törlés után sem használódik újra. */
export async function allocateNumber(tx: Db | Tx, eventId: string): Promise<number> {
  const [r] = await tx.update(events).set({ nextStationNumber: sql`${events.nextStationNumber} + 1` }).where(eq(events.id, eventId)).returning({ n: events.nextStationNumber });
  return (r?.n ?? 2) - 1;
}

export async function findNearby(db: Db | Tx, eventId: string, lat: number, lon: number, excludeStationId?: string) {
  const rows = await db.select().from(stations).where(and(eq(stations.eventId, eventId), eq(stations.status, "active")));
  return rows.filter((s) => s.id !== excludeStationId && distanceMeters(lat, lon, s.latitude, s.longitude) <= PROXIMITY_M)
    .map((s) => ({ stationNumber: s.number, distanceM: Math.round(distanceMeters(lat, lon, s.latitude, s.longitude)) }));
}

const validCoord = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Host pozíciójának megerősítése (host vagy admin); a végleges marker koordinátája lesz az állomás helye. */
export async function confirmHostLocation(db: Db, actor: { type: "host" | "admin"; id: string }, hostId: string, lat: number, lon: number) {
  if (!validCoord(lat, lon)) throw new AppError("invalid_coord", "Hibás koordináta.");
  const [h] = await db.select().from(hosts).where(eq(hosts.id, hostId));
  if (!h) throw new AppError("not_found", "Nem található.", 404);
  if (!["pending", "approved"].includes(h.status)) throw new AppError("bad_state", "Ez a jelentkezés már nem módosítható.", 409);
  await db.transaction(async (tx) => {
    await tx.update(hosts).set({ latitude: lat, longitude: lon, locationConfirmed: true, updatedAt: new Date() }).where(eq(hosts.id, hostId));
    await tx.update(stations).set({ latitude: lat, longitude: lon }).where(eq(stations.hostId, hostId));
    await audit(tx, { actorType: actor.type, actorId: actor.id, action: "host.location_confirmed", entityType: "host", entityId: hostId, eventId: h.eventId });
  });
  const [own] = await db.select({ id: stations.id }).from(stations).where(eq(stations.hostId, hostId));
  return { duplicateWarnings: await findNearby(db, h.eventId, lat, lon, own?.id) };
}

/** Jóváhagyáskor: létrehozza vagy újraaktiválja a host állomását. */
export async function ensureHostStation(tx: Tx, h: typeof hosts.$inferSelect): Promise<number> {
  if (!h.locationConfirmed || h.latitude == null || h.longitude == null) {
    throw new AppError("location_not_confirmed", "A host pozícióját előbb meg kell erősíteni a térképen.", 409);
  }
  const [existing] = await tx.select().from(stations).where(eq(stations.hostId, h.id));
  if (existing) {
    await tx.update(stations).set({
      address: h.address, latitude: h.latitude, longitude: h.longitude, pickupMode: h.pickupMode, participantNote: h.participantNote,
      status: "active", removedReason: null, removedAt: null,
    }).where(eq(stations.id, existing.id));
    return existing.number;
  }
  const number = await allocateNumber(tx, h.eventId);
  await tx.insert(stations).values({
    eventId: h.eventId, number, hostId: h.id, address: h.address, latitude: h.latitude, longitude: h.longitude,
    pickupMode: h.pickupMode, participantNote: h.participantNote,
  });
  return number;
}

/** Host visszalépésekor/címváltozásakor az állomás kikerül (szám megmarad a host számára). */
export async function deactivateHostStation(tx: Tx | Db, hostId: string, reason: string) {
  await tx.update(stations).set({ status: "removed", removedReason: reason, removedAt: new Date() })
    .where(and(eq(stations.hostId, hostId), eq(stations.status, "active")));
}

export async function createVirtualStation(
  db: Db, adminId: string, eventId: string,
  i: { address: string; lat: number; lon: number; pickupMode: PickupMode; participantNote?: string; confirmed: boolean },
) {
  if (!i.confirmed) throw new AppError("location_not_confirmed", "Erősítsd meg a marker pozícióját.", 409);
  if (!validCoord(i.lat, i.lon)) throw new AppError("invalid_coord", "Hibás koordináta.");
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev || ["closed", "cancelled"].includes(ev.status)) throw new AppError("bad_state", "Ehhez az eseményhez nem adható állomás.", 409);
  const warnings = await findNearby(db, eventId, i.lat, i.lon);
  const station = await db.transaction(async (tx) => {
    const number = await allocateNumber(tx, eventId);
    const [s] = await tx.insert(stations).values({
      eventId, number, hostId: null, address: i.address.trim(), latitude: i.lat, longitude: i.lon, pickupMode: i.pickupMode, participantNote: i.participantNote ?? null,
    }).returning();
    await audit(tx, { actorType: "admin", actorId: adminId, action: "station.create", entityType: "station", entityId: s!.id, eventId, after: { number, virtual: true, duringActive: ev.status === "active" } });
    return s!;
  });
  return { station, duplicateWarnings: warnings };
}

/** Eltávolítás indokkal; a szám nem használódik újra, az érintettek értesítést kapnak. */
export async function removeStation(db: Db, cfg: Config, adminId: string, stationId: string, reason: string) {
  if (!reason.trim()) throw new AppError("reason_required", "Az eltávolítás indoklása kötelező.");
  const [s] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!s) throw new AppError("not_found", "Az állomás nem található.", 404);
  if (s.status === "removed") throw new AppError("bad_state", "Az állomás már el van távolítva.", 409);
  const [ev] = await db.select().from(events).where(eq(events.id, s.eventId));
  await db.transaction(async (tx) => {
    await tx.update(stations).set({ status: "removed", removedReason: reason, removedAt: new Date() }).where(eq(stations.id, stationId));
    await audit(tx, { actorType: "admin", actorId: adminId, action: "station.remove", entityType: "station", entityId: stationId, eventId: s.eventId, reason, after: { number: s.number } });
    if (ev && ["active", "preparation", "registration_open"].includes(ev.status)) {
      const recipients = [
        ...(await tx.select({ id: teams.id, email: teams.email }).from(teams).where(and(eq(teams.eventId, s.eventId), eq(teams.status, "approved")))).map((r) => ({ ...r, kind: "team" })),
        ...(await tx.select({ id: hosts.id, email: hosts.email }).from(hosts).where(and(eq(hosts.eventId, s.eventId), eq(hosts.status, "approved")))).map((r) => ({ ...r, kind: "host" })),
      ];
      for (const r of recipients) {
        await enqueueEmail(tx, cfg, { type: "station_removal", recipient: r.email, data: { eventName: ev.name, stationNumber: s.number, reason }, dedupKey: `station_removal:${s.id}:${r.kind}:${r.id}`, eventId: s.eventId, entityType: "station", entityId: s.id });
      }
    }
  });
}

export async function requiredStationCount(db: Db, eventId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(stations).where(and(eq(stations.eventId, eventId), eq(stations.status, "active")));
  return r?.n ?? 0;
}

/** Résztvevői nézet: T−24 előtt csak a darabszám, utána a részletek. A host neve sosem szerepel. */
export async function stationsForParticipant(db: Db, eventId: string, now = new Date()) {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw new AppError("not_found", "Az esemény nem található.", 404);
  const rows = await db.select().from(stations).where(and(eq(stations.eventId, eventId), eq(stations.status, "active"))).orderBy(stations.number);
  const revealed = locationsRevealed(now, ev.plannedStart, ev.actualStart, ev.status as EventStatus);
  if (!revealed) return { revealed: false as const, count: rows.length };
  return {
    revealed: true as const, count: rows.length, radiusM: ev.checkinRadiusM,
    stations: rows.map((s) => ({
      id: s.id, number: s.number, label: `Állomás #${s.number}`, address: s.address, latitude: s.latitude, longitude: s.longitude,
      pickupMode: s.pickupMode, participantNote: s.participantNote,
    })),
  };
}

export async function listStationsAdmin(db: Db, eventId: string) {
  return db.select().from(stations).where(eq(stations.eventId, eventId)).orderBy(stations.number);
}
