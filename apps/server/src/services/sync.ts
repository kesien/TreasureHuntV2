import { and, eq, inArray, sql } from "drizzle-orm";
import { distanceMeters, isWithinRadius } from "@th/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { checkIns, events, photos, stations, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { MAX_ACCURACY_M } from "./checkins.js";
import { notifyAdmins } from "./outbox.js";
import { hit } from "./rateLimit.js";

/** Ennyi óraeltérést (a jövő felé) még elfogadunk. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_BATCH = 50;

export interface SyncCheckInItem {
  clientId: string;
  stationId: string;
  capturedAt: Date; // a telefon szerinti eredeti idő
  latitude: number; // csak az újraellenőrzés idejéig él, nem tárolódik
  longitude: number;
  accuracy: number | null;
}

export type SyncStatus = "accepted" | "duplicate" | "needs_review" | "rejected";
export interface SyncResult { clientId: string; status: SyncStatus; reason?: string; checkInStatus?: string }

/**
 * Az offline időbélyeg elbírálása az esemény időablakához képest. null = rendben.
 * Eseményvég előtti (pl. 19:58) időbélyeg elfogadható akkor is, ha a szinkron később jön; utána keletkezett nem.
 */
export function judgeTimestamp(ev: { status: string; actualStart: Date | null; actualEnd: Date | null }, at: Date, now: Date): string | null {
  if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) return "clock_anomaly";
  if (!ev.actualStart || at < ev.actualStart) return "before_event_start";
  if (ev.status === "closed" && ev.actualEnd && at > ev.actualEnd) return "after_event_end";
  return null;
}

/** Elemenként független feldolgozás: egy hibás elem nem blokkolja a többit. */
export async function syncCheckIns(db: Db, cfg: Config, teamId: string, items: SyncCheckInItem[]): Promise<SyncResult[]> {
  if (items.length > MAX_BATCH) throw new AppError("batch_too_large", `Egyszerre legfeljebb ${MAX_BATCH} elem küldhető.`);
  if (!(await hit(db, "sync", teamId, 60, 60))) throw new AppError("rate_limited", "Túl sok szinkronkérés. Próbáld újra egy perc múlva.", 429);
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw new AppError("not_found", "Nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  const out: SyncResult[] = [];
  for (const item of items) {
    try {
      out.push(await syncOne(db, cfg, team, ev!, item));
    } catch (e) {
      out.push({ clientId: item.clientId, status: "rejected", reason: e instanceof AppError ? e.code : "server_error" });
    }
  }
  return out;
}

async function syncOne(db: Db, cfg: Config, team: typeof teams.$inferSelect, ev: typeof events.$inferSelect, item: SyncCheckInItem): Promise<SyncResult> {
  const id = item.clientId;
  // Idempotencia: ugyanaz a queue-elem vagy ugyanaz a csapat+állomás párosítás nem hoz létre újat
  const [byClient] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, team.id), eq(checkIns.clientId, id)));
  const [byStation] = byClient ? [byClient] : await db.select().from(checkIns).where(and(eq(checkIns.teamId, team.id), eq(checkIns.stationId, item.stationId)));
  if (byStation) return { clientId: id, status: "duplicate", checkInStatus: byStation.status };

  if (team.status !== "approved") return { clientId: id, status: "rejected", reason: "team_not_active" };
  if (ev.status === "cancelled") return { clientId: id, status: "rejected", reason: "event_cancelled" };
  if (!["active", "closed"].includes(ev.status)) return { clientId: id, status: "rejected", reason: "event_not_started" };
  // Ismeretlen állomásra az offline kliens nem hozhat létre check-int
  const [st] = await db.select().from(stations).where(and(eq(stations.id, item.stationId), eq(stations.eventId, ev.id)));
  if (!st) return { clientId: id, status: "rejected", reason: "unknown_station" };

  const now = new Date();
  let review: string | null = st.status === "removed" ? "station_removed" : judgeTimestamp(ev, item.capturedAt, now);
  const d = distanceMeters(item.latitude, item.longitude, st.latitude, st.longitude);
  if (!review && !isWithinRadius(d, ev.checkinRadiusM)) review = "distance_mismatch";
  if (!review && item.accuracy != null && item.accuracy > MAX_ACCURACY_M) review = "inaccurate";

  const status = review ? "needs_review" : "accepted";
  const rows = await db.insert(checkIns).values({
    eventId: ev.id, teamId: team.id, stationId: st.id, status, source: "offline", originalAt: item.capturedAt, receivedAt: now,
    distanceM: Math.round(d), accuracyM: item.accuracy == null ? null : Math.round(item.accuracy), clientId: id, reviewReason: review,
  }).onConflictDoNothing().returning({ id: checkIns.id });
  if (rows.length === 0) return { clientId: id, status: "duplicate" };
  if (review) {
    await audit(db, { actorType: "system", action: "checkin.needs_review", entityType: "checkin", entityId: rows[0]!.id, eventId: ev.id, after: { reason: review, teamId: team.id } });
    await notifyAdmins(db, cfg, "Check-in elbírálásra vár", `Egy offline check-in ellenőrzést igényel (${review}). Nézd meg az Ellenőrzés listában.`, `admin_review:${rows[0]!.id}`, ev.id);
    return { clientId: id, status: "needs_review", reason: review };
  }
  return { clientId: id, status: "accepted" };
}

export async function listReviews(db: Db, eventId: string) {
  const rows = await db.select({ c: checkIns, team: teams.name, number: stations.number, stationStatus: stations.status }).from(checkIns)
    .innerJoin(teams, eq(teams.id, checkIns.teamId)).innerJoin(stations, eq(stations.id, checkIns.stationId))
    .where(and(eq(checkIns.eventId, eventId), eq(checkIns.status, "needs_review"))).orderBy(checkIns.receivedAt);
  const out = [];
  for (const r of rows) {
    const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.teamId, r.c.teamId), eq(photos.stationId, r.c.stationId), eq(photos.status, "pending_review")));
    out.push({
      id: r.c.id, team: r.team, stationNumber: r.number, stationRemoved: r.stationStatus === "removed", reason: r.c.reviewReason,
      originalAt: r.c.originalAt, receivedAt: r.c.receivedAt, pendingPhotos: p?.n ?? 0,
    });
  }
  return out;
}

/**
 * Admin döntés. Elfogadás: a check-in érvényes, a hozzá tartozó (várakozó) fotók normál módon láthatóvá válnak.
 * Elutasítás: a check-in nem számít, a fotók nem jelennek meg a galériában (az admin még látja).
 */
export async function decideReview(db: Db, adminId: string, checkInId: string, decision: "accept" | "reject", reason?: string) {
  const [c] = await db.select().from(checkIns).where(eq(checkIns.id, checkInId));
  if (!c) throw new AppError("not_found", "A check-in nem található.", 404);
  if (c.status !== "needs_review") throw new AppError("bad_state", "Ez a check-in nem vár elbírálásra.", 409);
  await db.transaction(async (tx) => {
    await tx.update(checkIns).set({
      status: decision === "accept" ? "accepted" : "rejected", reviewedBy: adminId, reviewedAt: new Date(), reason: reason ?? c.reason,
    }).where(eq(checkIns.id, checkInId));
    await tx.update(photos).set({ status: decision === "accept" ? "visible" : "rejected" })
      .where(and(eq(photos.teamId, c.teamId), eq(photos.stationId, c.stationId), inArray(photos.status, ["pending_review"])));
    await audit(tx, { actorType: "admin", actorId: adminId, action: decision === "accept" ? "checkin.review_accept" : "checkin.review_reject", entityType: "checkin", entityId: checkInId, eventId: c.eventId, reason, before: { reviewReason: c.reviewReason } });
  });
}
