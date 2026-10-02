import { and, desc, eq, sql } from "drizzle-orm";
import { OUT_OF_GIFTS_THRESHOLD } from "@th/shared";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/client.js";
import { checkIns, events, giftCycles, giftReports, hosts, stations, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { enqueueEmail, notifyAdmins } from "./outbox.js";

/** Az állomás aktuális ajándék-ciklusa; ha még nincs, létrejön az első. */
export async function currentCycle(db: Db | Tx, stationId: string) {
  const [c] = await db.select().from(giftCycles).where(eq(giftCycles.stationId, stationId)).orderBy(desc(giftCycles.seq)).limit(1);
  if (c) return c;
  const [created] = await db.insert(giftCycles).values({ stationId, seq: 1 }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(giftCycles).where(eq(giftCycles.stationId, stationId)).orderBy(desc(giftCycles.seq)).limit(1);
  return again!;
}

export async function reportCount(db: Db | Tx, cycleId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(distinct ${giftReports.teamId})::int` }).from(giftReports).where(eq(giftReports.cycleId, cycleId));
  return r?.n ?? 0;
}

/** "Valószínűleg elfogyott": származtatott figyelmeztetés, nem külön státusz. */
export function isLikelyOut(status: string, reports: number): boolean {
  return status === "has_gifts" && reports >= OUT_OF_GIFTS_THRESHOLD;
}

export async function giftSummary(db: Db | Tx, stationId: string) {
  const c = await currentCycle(db, stationId);
  const reports = await reportCount(db, c.id);
  return { cycleId: c.id, status: c.status as "has_gifts" | "depleted", note: c.note, reports, likelyOut: isLikelyOut(c.status, reports) };
}

/** Csapat jelzése: csak check-in után, ciklusonként egyszer; a 3. különböző jelzés figyelmeztetést indít. */
export async function reportOutOfGifts(db: Db, cfg: Config, teamId: string, stationId: string) {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!team || !st || st.eventId !== team.eventId || st.status !== "active") throw new AppError("not_found", "Az állomás nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  if (team.status !== "approved" || ev?.status !== "active") throw new AppError("not_active", "Jelzés most nem lehetséges.", 409);
  const [ci] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.stationId, stationId), eq(checkIns.status, "accepted")));
  if (!ci) throw new AppError("checkin_required", "Jelezni csak az állomáson történt becsekkolás után lehet.", 409);

  const cycle = await currentCycle(db, stationId);
  const inserted = await db.insert(giftReports).values({ cycleId: cycle.id, teamId }).onConflictDoNothing().returning({ id: giftReports.id });
  if (inserted.length === 0) return { alreadyReported: true, ...(await giftSummary(db, stationId)) };
  await audit(db, { actorType: "team", actorId: teamId, action: "gift.out_reported", entityType: "station", entityId: stationId, eventId: ev.id, after: { cycleSeq: cycle.seq } });

  const summary = await giftSummary(db, stationId);
  if (summary.likelyOut) {
    // Atomikusan "kiosztjuk" a figyelmeztetést, hogy ciklusonként csak egyszer menjen ki
    const claimed = await db.update(giftCycles).set({ warningSentAt: new Date() })
      .where(and(eq(giftCycles.id, cycle.id), sql`${giftCycles.warningSentAt} is null`)).returning({ id: giftCycles.id });
    if (claimed.length) await sendLikelyOutNotifications(db, cfg, st, cycle.id, ev.id, ev.name);
  }
  return { alreadyReported: false, ...summary };
}

async function sendLikelyOutNotifications(db: Db, cfg: Config, st: typeof stations.$inferSelect, cycleId: string, eventId: string, eventName: string) {
  await audit(db, { actorType: "system", action: "gift.likely_out", entityType: "station", entityId: st.id, eventId, after: { number: st.number } });
  if (st.hostId) {
    const [h] = await db.select().from(hosts).where(eq(hosts.id, st.hostId));
    if (h) {
      await enqueueEmail(db, cfg, {
        type: "station_warning", recipient: h.email, data: { eventName, stationNumber: st.number, message: `⚠️ Valószínűleg elfogyott: ${OUT_OF_GIFTS_THRESHOLD} csapat jelezte, hogy nincs több ajándék. Ha feltöltötted, a felületen jelezd az "Újra feltöltöttem" gombbal.` },
        dedupKey: `likely_out:host:${cycleId}`, eventId, entityType: "station", entityId: st.id,
      });
    }
  }
  await notifyAdmins(db, cfg, `Valószínűleg elfogyott – Állomás #${st.number}`, `Az Állomás #${st.number} állomáson ${OUT_OF_GIFTS_THRESHOLD} csapat jelezte az ajándék elfogyását.`, `admin_likely_out:${cycleId}`, eventId);
  // Csapatok, amelyek még nem jártak ott
  const visited = db.select({ id: checkIns.teamId }).from(checkIns).where(eq(checkIns.stationId, st.id));
  const others = await db.select({ id: teams.id, email: teams.email }).from(teams).where(and(eq(teams.eventId, eventId), eq(teams.status, "approved"), sql`${teams.id} not in (${visited})`));
  for (const t of others) {
    await enqueueEmail(db, cfg, {
      type: "station_warning", recipient: t.email, data: { eventName, stationNumber: st.number, message: `Az Állomás #${st.number} állomáson valószínűleg elfogyott az ajándék.` },
      dedupKey: `likely_out:team:${cycleId}:${t.id}`, eventId, entityType: "station", entityId: st.id,
    });
  }
}

type Actor = { type: "host" | "admin"; id: string };

async function loadForHostAction(db: Db, actor: Actor, stationId: string) {
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!st) throw new AppError("not_found", "Az állomás nem található.", 404);
  if (actor.type === "host" && st.hostId !== actor.id) throw new AppError("forbidden", "Ez nem a te állomásod.", 403);
  const [ev] = await db.select().from(events).where(eq(events.id, st.eventId));
  if (actor.type === "host" && ev?.status !== "active") throw new AppError("not_active", "Az esemény most nem aktív.", 409);
  if (ev?.status === "cancelled") throw new AppError("not_active", "Az esemény elmarad.", 409);
  return { st, ev: ev! };
}

/** Elfogyott állapot beállítása (host: megjegyzéssel; admin: indokkal). */
export async function markDepleted(db: Db, actor: Actor, stationId: string, note: string | null, reason?: string) {
  const { st, ev } = await loadForHostAction(db, actor, stationId);
  if (actor.type === "admin" && !reason?.trim()) throw new AppError("reason_required", "A kézi módosítás indoklása kötelező.");
  const c = await currentCycle(db, stationId);
  if (c.status === "depleted") throw new AppError("bad_state", "Az állomás már elfogyottként szerepel.", 409);
  await db.update(giftCycles).set({ status: "depleted", note: note?.trim() || null, depletedAt: new Date() }).where(eq(giftCycles.id, c.id));
  await audit(db, { actorType: actor.type, actorId: actor.id, action: "gift.depleted", entityType: "station", entityId: stationId, eventId: ev.id, reason, after: { cycleSeq: c.seq } });
  return giftSummary(db, st.id);
}

/** "Újra feltöltöttem": új ciklus indul, a korábbi jelzések nem számítanak bele a küszöbbe. */
export async function restock(db: Db, actor: Actor, stationId: string, reason?: string) {
  const { st, ev } = await loadForHostAction(db, actor, stationId);
  if (actor.type === "admin" && !reason?.trim()) throw new AppError("reason_required", "A kézi módosítás indoklása kötelező.");
  const c = await currentCycle(db, stationId);
  if (c.status === "has_gifts" && (await reportCount(db, c.id)) === 0) throw new AppError("bad_state", "Az állomás már aktív, nincs mit visszaállítani.", 409);
  await db.insert(giftCycles).values({ stationId, seq: c.seq + 1 });
  await audit(db, { actorType: actor.type, actorId: actor.id, action: "gift.restocked", entityType: "station", entityId: stationId, eventId: ev.id, reason, after: { newCycleSeq: c.seq + 1 } });
  return giftSummary(db, st.id);
}

/** Admin: jelentő csapatok és időpontok minden ciklusban. */
export async function adminGiftHistory(db: Db, stationId: string) {
  const cycles = await db.select().from(giftCycles).where(eq(giftCycles.stationId, stationId)).orderBy(giftCycles.seq);
  const out = [];
  for (const c of cycles) {
    const reports = await db.select({ team: teams.name, at: giftReports.at }).from(giftReports).innerJoin(teams, eq(teams.id, giftReports.teamId)).where(eq(giftReports.cycleId, c.id)).orderBy(giftReports.at);
    out.push({ seq: c.seq, status: c.status, note: c.note, startedAt: c.startedAt, depletedAt: c.depletedAt, reports });
  }
  return out;
}
