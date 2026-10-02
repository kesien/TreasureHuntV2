import { and, eq, sql } from "drizzle-orm";
import { distanceMeters, isWithinRadius } from "@th/shared";
import type { Db } from "../db/client.js";
import { checkIns, events, hosts, stations, teamMembers, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { giftSummary } from "./gifts.js";
import { hit } from "./rateLimit.js";

/** E fölötti GPS-pontatlanságnál nem döntünk (a csapatnak újra kell próbálnia). */
export const MAX_ACCURACY_M = 100;

export type CheckInResult =
  | { result: "ok"; alreadyCheckedIn: boolean; distanceM: number; checkedInAt: Date }
  | { result: "too_far"; distanceM: number; radiusM: number }
  | { result: "inaccurate"; accuracyM: number; maxAccuracyM: number };

/**
 * Online check-in. A szerver számolja a távolságot és hozza meg a döntést; a koordináta csak a kérés
 * idejéig él (nem tárolódik, nem naplózódik) – csak a számolt távolság, a pontosság és az idő marad meg.
 */
export async function checkIn(db: Db, teamId: string, stationId: string, lat: number, lon: number, accuracyM: number | null): Promise<CheckInResult> {
  if (!(await hit(db, "checkin", teamId, 40, 60))) throw new AppError("rate_limited", "Túl sok próbálkozás. Próbáld újra egy perc múlva.", 429);
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!team || !st || st.eventId !== team.eventId) throw new AppError("not_found", "Az állomás nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  if (ev?.status !== "active") throw new AppError("not_active", "Az esemény most nem aktív.", 409);
  if (team.status !== "approved") throw new AppError("not_active", "A csapat hozzáférése nem aktív.", 403);
  if (st.status !== "active") throw new AppError("station_removed", "Ez az állomás már nem része az eseménynek.", 409);

  const [existing] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.stationId, stationId)));
  if (existing && existing.status !== "rejected") {
    return { result: "ok", alreadyCheckedIn: true, distanceM: existing.distanceM ?? 0, checkedInAt: existing.originalAt };
  }
  if (accuracyM != null && accuracyM > MAX_ACCURACY_M) return { result: "inaccurate", accuracyM: Math.round(accuracyM), maxAccuracyM: MAX_ACCURACY_M };
  const d = distanceMeters(lat, lon, st.latitude, st.longitude);
  if (!isWithinRadius(d, ev.checkinRadiusM)) return { result: "too_far", distanceM: Math.round(d), radiusM: ev.checkinRadiusM };

  const now = new Date();
  const rows = await db.insert(checkIns).values({
    eventId: ev.id, teamId, stationId, status: "accepted", source: "online", originalAt: now, receivedAt: now,
    distanceM: Math.round(d), accuracyM: accuracyM == null ? null : Math.round(accuracyM),
  }).onConflictDoNothing().returning();
  if (rows.length === 0) { // párhuzamos dupla kérés
    const [again] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.stationId, stationId)));
    return { result: "ok", alreadyCheckedIn: true, distanceM: again?.distanceM ?? Math.round(d), checkedInAt: again?.originalAt ?? now };
  }
  return { result: "ok", alreadyCheckedIn: false, distanceM: Math.round(d), checkedInAt: now };
}

/** Admin által rögzített check-in; indok kötelező, auditált. */
export async function manualCheckIn(db: Db, adminId: string, teamId: string, stationId: string, at: Date, reason: string) {
  if (!reason.trim()) throw new AppError("reason_required", "A manuális check-in indoklása kötelező.");
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!team || !st || st.eventId !== team.eventId) throw new AppError("not_found", "A csapat vagy az állomás nem található.", 404);
  if (st.status !== "active") throw new AppError("station_removed", "Az állomás el van távolítva.", 409);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  if (!ev || !["active", "closed"].includes(ev.status)) throw new AppError("not_active", "Az eseményhez most nem rögzíthető check-in.", 409);
  const [existing] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.stationId, stationId)));
  const values = { status: "accepted", source: "admin", originalAt: at, receivedAt: new Date(), adminRecorded: true, reason, distanceM: null, accuracyM: null };
  let id: string;
  if (existing) {
    if (existing.status === "accepted") throw new AppError("already_checked_in", "A csapat már becsekkolt ide.", 409);
    await db.update(checkIns).set(values).where(eq(checkIns.id, existing.id)); // pl. elutasított/review check-in felülbírálása
    id = existing.id;
  } else {
    const [r] = await db.insert(checkIns).values({ eventId: ev.id, teamId, stationId, ...values }).returning({ id: checkIns.id });
    id = r!.id;
  }
  await audit(db, { actorType: "admin", actorId: adminId, action: "checkin.manual", entityType: "checkin", entityId: id, eventId: ev.id, reason, after: { teamId, stationId, at } });
}

/** Csapat haladása: játékidő az első sikeres check-intől; a kész állapot dinamikusan számolódik. */
export async function teamProgress(db: Db, teamId: string, now = new Date()) {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw new AppError("not_found", "Nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  const active = await db.select({ id: stations.id }).from(stations).where(and(eq(stations.eventId, team.eventId), eq(stations.status, "active")));
  const mine = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.status, "accepted")));
  const activeIds = new Set(active.map((s) => s.id));
  const done = mine.filter((c) => activeIds.has(c.stationId));
  const required = active.length;
  const completed = done.length;
  const finished = required > 0 && completed >= required;
  const first = mine.length ? new Date(Math.min(...mine.map((c) => c.originalAt.getTime()))) : null;
  let endAt: Date | null = null;
  if (finished) endAt = new Date(Math.max(...done.map((c) => c.originalAt.getTime())));
  else if (ev?.status === "closed" && ev.actualEnd) endAt = ev.actualEnd; // az esemény végén a részleges állapot befagy
  const elapsedSec = first ? Math.max(0, Math.floor(((endAt ?? now).getTime() - first.getTime()) / 1000)) : 0;
  return { firstCheckInAt: first, completed, required, finished, frozen: endAt !== null, elapsedSec, completedStationIds: done.map((c) => c.stationId) };
}

/** Host irányítópult: saját állomás, látogatók (csapatnév + létszám), ajándék állapot. Tagnevek és jelentők nem láthatók. */
export async function hostDashboard(db: Db, hostId: string) {
  const [h] = await db.select().from(hosts).where(eq(hosts.id, hostId));
  if (!h) throw new AppError("not_found", "Nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, h.eventId));
  const [st] = await db.select().from(stations).where(and(eq(stations.hostId, hostId), eq(stations.status, "active")));
  const [c] = await db.select({
    children: sql<number>`count(*) filter (where ${teamMembers.category} = 'child')::int`, total: sql<number>`count(*)::int`,
  }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(and(eq(teams.eventId, h.eventId), eq(teams.status, "approved")));
  const children = c?.children ?? 0;
  const base = {
    event: { name: ev?.name, status: ev?.status, plannedStart: ev?.plannedStart, plannedEnd: ev?.plannedEnd },
    hostStatus: h.status, pickupMode: h.pickupMode, participantNote: h.participantNote,
    counts: { children, adults: (c?.total ?? 0) - children, total: c?.total ?? 0 },
  };
  if (!st) return { ...base, station: null, visits: [], gift: null };
  const visits = await db.select({
    teamName: teams.name, at: checkIns.originalAt, teamId: teams.id,
  }).from(checkIns).innerJoin(teams, eq(teams.id, checkIns.teamId)).where(and(eq(checkIns.stationId, st.id), eq(checkIns.status, "accepted"))).orderBy(sql`${checkIns.originalAt} desc`);
  const sizes = await db.select({
    teamId: teamMembers.teamId, children: sql<number>`count(*) filter (where ${teamMembers.category} = 'child')::int`, total: sql<number>`count(*)::int`,
  }).from(teamMembers).groupBy(teamMembers.teamId);
  const by = new Map(sizes.map((s) => [s.teamId, s]));
  const g = await giftSummary(db, st.id);
  return {
    ...base,
    station: { id: st.id, number: st.number, label: `Állomás #${st.number}`, address: st.address, latitude: st.latitude, longitude: st.longitude },
    visits: visits.map((v) => ({
      teamName: v.teamName, checkedInAt: v.at, total: by.get(v.teamId)?.total ?? 0, children: by.get(v.teamId)?.children ?? 0,
      adults: (by.get(v.teamId)?.total ?? 0) - (by.get(v.teamId)?.children ?? 0),
    })),
    gift: { status: g.status, note: g.note, reportCount: g.reports, likelyOut: g.likelyOut },
  };
}
