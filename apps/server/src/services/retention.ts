import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { PARTICIPANT_ACCESS_DAYS_AFTER_CLOSE } from "@th/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  accessCredentials, accessSessions, adminSessions, adminTokens, emailDeliveries, events, geocodeCache, hosts, participantTokens, photos,
  stations, teamMembers, teams,
} from "../db/schema.js";
import { removeFilesFor } from "./photoFiles.js";
import { audit } from "./audit.js";
import { revokeAccess } from "./accessAuth.js";

/** Operátori adatmegőrzési szabály (nem jogi állítás): személyes adat 12, fotó 24 hónap után. */
export const PERSONAL_DATA_MONTHS = 12;
export const PHOTO_MONTHS = 24;
const monthsAgo = (now: Date, m: number) => { const d = new Date(now); d.setMonth(d.getMonth() - m); return d; };

/** Egy csapat személyes adatainak törlése; a név egyedi marad, a státusz és az aggregált adatok megmaradnak. */
export async function anonymizeTeam(db: Db, teamId: string) {
  const short = teamId.slice(0, 8);
  await db.update(teams).set({ name: `Anonimizált csapat ${short}`, contactName: "Anonimizált", email: `anon-${short}@invalid`, pendingEmail: null, phone: "", idempotencyKey: null }).where(eq(teams.id, teamId));
  await db.update(teamMembers).set({ name: "Anonimizált" }).where(eq(teamMembers.teamId, teamId)); // a gyermek/felnőtt bontás megmarad
  await db.delete(participantTokens).where(and(eq(participantTokens.subjectType, "team"), eq(participantTokens.subjectId, teamId)));
  await revokeAccess(db, { subjectType: "team", subjectId: teamId });
}

export async function anonymizeHost(db: Db, hostId: string) {
  const short = hostId.slice(0, 8);
  await db.update(hosts).set({
    contactName: "Anonimizált", email: `anon-${short}@invalid`, phone: "", address: "Anonimizált cím", normalizedAddress: `anon-${hostId}`,
    latitude: null, longitude: null, participantNote: null, idempotencyKey: null,
  }).where(eq(hosts.id, hostId));
  await db.update(stations).set({ address: "Anonimizált cím", latitude: 0, longitude: 0, participantNote: null }).where(eq(stations.hostId, hostId));
  await db.delete(participantTokens).where(and(eq(participantTokens.subjectType, "host"), eq(participantTokens.subjectId, hostId)));
  await revokeAccess(db, { subjectType: "host", subjectId: hostId });
}

/**
 * Időalapú takarítás, idempotensen az adatbázis állapotából:
 *  - résztvevői hozzáférések lezárása az esemény vége + 7 nap után,
 *  - személyes adatok anonimizálása 12 hónappal a lezárás után,
 *  - fotók törlése 24 hónappal a lezárás után,
 *  - lejárt munkamenetek, tokenek és régi e-mail sorok / geokódolási cache törlése.
 * Az audit napló sosem törlődik.
 */
export async function runRetention(db: Db, cfg: Config, now = new Date()) {
  const result = { accessRevoked: 0, anonymized: 0, photosPurged: 0 };

  const toRevoke = await db.select().from(events).where(and(eq(events.status, "closed"), isNull(events.accessRevokedAt)));
  for (const ev of toRevoke) {
    const end = ev.actualEnd ?? ev.plannedEnd;
    if (now.getTime() < end.getTime() + PARTICIPANT_ACCESS_DAYS_AFTER_CLOSE * 86400_000) continue;
    await revokeAccess(db, { eventId: ev.id });
    await db.update(events).set({ accessRevokedAt: now }).where(eq(events.id, ev.id));
    await audit(db, { actorType: "system", action: "event.access_expired", entityType: "event", entityId: ev.id, eventId: ev.id });
    result.accessRevoked++;
  }

  const personalCutoff = monthsAgo(now, PERSONAL_DATA_MONTHS);
  const due = await db.select().from(events).where(and(inArray(events.status, ["closed", "cancelled"]), isNull(events.anonymizedAt)));
  for (const ev of due) {
    if ((ev.actualEnd ?? ev.updatedAt) > personalCutoff) continue;
    for (const t of await db.select({ id: teams.id }).from(teams).where(eq(teams.eventId, ev.id))) await anonymizeTeam(db, t.id);
    for (const h of await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.eventId, ev.id))) await anonymizeHost(db, h.id);
    await db.delete(emailDeliveries).where(eq(emailDeliveries.eventId, ev.id));
    await db.update(events).set({ anonymizedAt: now, organizerContact: ev.organizerContact }).where(eq(events.id, ev.id));
    await audit(db, { actorType: "system", action: "retention.anonymize", entityType: "event", entityId: ev.id, eventId: ev.id });
    result.anonymized++;
  }

  const photoCutoff = monthsAgo(now, PHOTO_MONTHS);
  const oldEvents = await db.select({ id: events.id, end: events.actualEnd, upd: events.updatedAt }).from(events).where(inArray(events.status, ["closed", "cancelled"]));
  for (const ev of oldEvents) {
    if ((ev.end ?? ev.upd) > photoCutoff) continue;
    const rows = await db.select().from(photos).where(and(eq(photos.eventId, ev.id), sql`${photos.status} <> 'deleted'`));
    if (!rows.length) continue;
    await removeFilesFor(cfg, rows);
    await db.update(photos).set({ status: "deleted", fileKey: null, thumbKey: null, deletedAt: now, deletedBy: "retention" }).where(inArray(photos.id, rows.map((r) => r.id)));
    await audit(db, { actorType: "system", action: "retention.photos_deleted", entityType: "event", entityId: ev.id, eventId: ev.id, after: { count: rows.length } });
    result.photosPurged += rows.length;
  }

  await db.delete(adminSessions).where(lte(adminSessions.expiresAt, now));
  await db.delete(adminTokens).where(lte(adminTokens.expiresAt, now));
  await db.delete(participantTokens).where(lte(participantTokens.expiresAt, now));
  await db.delete(emailDeliveries).where(and(lte(emailDeliveries.createdAt, personalCutoff), eq(emailDeliveries.status, "sent")));
  await db.delete(geocodeCache).where(lte(geocodeCache.createdAt, personalCutoff));
  void accessCredentials; void accessSessions;
  return result;
}
