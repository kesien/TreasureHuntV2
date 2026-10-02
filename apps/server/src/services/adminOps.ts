import { access, constants, mkdir } from "node:fs/promises";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  admins, auditLogs, checkIns, dataRequests, emailDeliveries, errorEvents, events, giftCycles, giftReports, hosts, photos, settings, stations, teamMembers, teams,
} from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { lastBackups } from "./backup.js";
import { currentCycle, isLikelyOut, reportCount } from "./gifts.js";

/** Esemény statisztika (ranglista nélkül). Csak a jóváhagyott csapatok számítanak a résztvevői létszámba. */
export async function eventStats(db: Db, eventId: string) {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw new AppError("not_found", "Az esemény nem található.", 404);
  const byStatus = await db.select({ status: teams.status, n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.eventId, eventId)).groupBy(teams.status);
  const hostByStatus = await db.select({ status: hosts.status, n: sql<number>`count(*)::int` }).from(hosts).where(eq(hosts.eventId, eventId)).groupBy(hosts.status);
  const count = (rows: Array<{ status: string; n: number }>, s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const [m] = await db.select({
    children: sql<number>`count(*) filter (where ${teamMembers.category} = 'child')::int`, total: sql<number>`count(*)::int`,
  }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(and(eq(teams.eventId, eventId), eq(teams.status, "approved")));
  const active = await db.select({ id: stations.id }).from(stations).where(and(eq(stations.eventId, eventId), eq(stations.status, "active")));
  const activeIds = new Set(active.map((s) => s.id));
  const accepted = await db.select({ teamId: checkIns.teamId, stationId: checkIns.stationId }).from(checkIns)
    .innerJoin(teams, eq(teams.id, checkIns.teamId)).where(and(eq(checkIns.eventId, eventId), eq(checkIns.status, "accepted"), eq(teams.status, "approved")));
  const perTeam = new Map<string, number>();
  let completedCheckIns = 0;
  for (const c of accepted) if (activeIds.has(c.stationId)) { completedCheckIns++; perTeam.set(c.teamId, (perTeam.get(c.teamId) ?? 0) + 1); }
  const approvedTeams = count(byStatus, "approved");
  const completedTeams = active.length > 0 ? [...perTeam.values()].filter((n) => n >= active.length).length : 0;
  const [ph] = await db.select({ n: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.eventId, eventId), sql`${photos.status} in ('visible','hidden_reported','pending_review')`));
  const [gr] = await db.select({ n: sql<number>`count(*)::int` }).from(giftReports)
    .innerJoin(giftCycles, eq(giftCycles.id, giftReports.cycleId)).innerJoin(stations, eq(stations.id, giftCycles.stationId)).where(eq(stations.eventId, eventId));
  let likelyOut = 0;
  for (const s of active) { const c = await currentCycle(db, s.id); if (isLikelyOut(c.status, await reportCount(db, c.id))) likelyOut++; }
  const [rv] = await db.select({ n: sql<number>`count(*)::int` }).from(checkIns).where(and(eq(checkIns.eventId, eventId), eq(checkIns.status, "needs_review")));
  const [rp] = await db.select({ n: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.eventId, eventId), eq(photos.status, "hidden_reported")));
  return {
    event: { id: ev.id, name: ev.name, status: ev.status },
    teams: { approved: approvedTeams, pending: count(byStatus, "pending"), withdrawn: count(byStatus, "withdrawn"), rejected: count(byStatus, "rejected") },
    hosts: { approved: count(hostByStatus, "approved"), pending: count(hostByStatus, "pending"), withdrawn: count(hostByStatus, "withdrawn") },
    participants: { total: m?.total ?? 0, children: m?.children ?? 0, adults: (m?.total ?? 0) - (m?.children ?? 0) },
    stations: active.length,
    completedCheckIns, completedTeams, partialTeams: [...perTeam.values()].filter((n) => n < active.length).length,
    photos: ph?.n ?? 0, outOfGiftsReports: gr?.n ?? 0, likelyOutStations: likelyOut,
    pendingApplications: count(byStatus, "pending") + count(hostByStatus, "pending"),
    reviewsPending: rv?.n ?? 0, reportedPhotos: rp?.n ?? 0,
  };
}

export interface AuditQuery { q?: string; action?: string; entityType?: string; actorId?: string; from?: Date; to?: Date; limit?: number; offset?: number }

/** Audit napló keresés/szűrés; csak olvasható, az actor megjelenítő neve az admin táblából jön. */
export async function queryAudit(db: Db, f: AuditQuery) {
  const conds = [];
  if (f.action) conds.push(ilike(auditLogs.action, `%${f.action}%`));
  if (f.entityType) conds.push(eq(auditLogs.entityType, f.entityType));
  if (f.actorId) conds.push(eq(auditLogs.actorId, f.actorId));
  if (f.from) conds.push(gte(auditLogs.at, f.from));
  if (f.to) conds.push(lte(auditLogs.at, f.to));
  if (f.q) conds.push(or(ilike(auditLogs.action, `%${f.q}%`), ilike(auditLogs.reason, `%${f.q}%`), sql`${auditLogs.entityId}::text ilike ${"%" + f.q + "%"}`)!);
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select({ a: auditLogs, actor: admins.displayName }).from(auditLogs).leftJoin(admins, eq(admins.id, auditLogs.actorId)).where(where)
    .orderBy(desc(auditLogs.at)).limit(Math.min(f.limit ?? 50, 200)).offset(f.offset ?? 0);
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(where);
  return { total: total?.n ?? 0, rows: rows.map((r) => ({ ...r.a, actorName: r.actor ?? (r.a.actorType === "system" ? "Rendszer" : r.a.actorType) })) };
}

export async function recordError(db: Db, message: string, route: string | undefined, correlationId: string) {
  try {
    await db.insert(errorEvents).values({ message: message.slice(0, 300), route: route?.split("?")[0]?.slice(0, 200), correlationId });
  } catch {
    // a hibanapló hibája nem okozhat újabb hibát
  }
}

export async function heartbeat(db: Db) {
  await db.insert(settings).values({ key: "worker_heartbeat", value: { at: new Date().toISOString() } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { at: new Date().toISOString() }, updatedAt: new Date() } });
}

export type Level = "ok" | "warning" | "error";

/** Rendszerállapot: DB, tárhely, e-mail, háttérmunkák, mentés, verzió, kritikus hibák. */
export async function systemStatus(db: Db, cfg: Config, now = new Date()) {
  const checks: Record<string, { level: Level; detail: string }> = {};
  try { await db.execute(sql`select 1`); checks.database = { level: "ok", detail: "Elérhető" }; }
  catch { checks.database = { level: "error", detail: "Az adatbázis nem érhető el" }; }
  try { await mkdir(cfg.PHOTO_DIR, { recursive: true }); await access(cfg.PHOTO_DIR, constants.W_OK); checks.storage = { level: "ok", detail: "Írható" }; }
  catch { checks.storage = { level: "error", detail: "A fotótároló nem írható" }; }

  if (checks.database!.level === "ok") {
    const [lastSent] = await db.select({ at: emailDeliveries.sentAt }).from(emailDeliveries).where(eq(emailDeliveries.status, "sent")).orderBy(desc(emailDeliveries.sentAt)).limit(1);
    const [failed] = await db.select({ n: sql<number>`count(*)::int` }).from(emailDeliveries).where(eq(emailDeliveries.status, "failed"));
    const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(emailDeliveries).where(and(eq(emailDeliveries.status, "pending"), sql`${emailDeliveries.attempts} > 0`));
    checks.email = (failed?.n ?? 0) > 0 ? { level: "warning", detail: `${failed!.n} sikertelen levél` }
      : (pending?.n ?? 0) > 0 ? { level: "warning", detail: `${pending!.n} levél újrapróbálás alatt` }
      : { level: "ok", detail: lastSent?.at ? `Utolsó sikeres küldés: ${lastSent.at.toISOString()}` : "Még nem volt küldés" };

    const [hb] = await db.select().from(settings).where(eq(settings.key, "worker_heartbeat"));
    const hbAt = hb ? new Date((hb.value as { at: string }).at) : null;
    checks.jobs = !hbAt || now.getTime() - hbAt.getTime() > 120_000 ? { level: "warning", detail: "A háttérfolyamat nem jelzett az elmúlt 2 percben" } : { level: "ok", detail: "Működik" };

    const { lastOk, last } = await lastBackups(db);
    checks.backup = !lastOk?.finishedAt ? { level: "warning", detail: "Még nincs sikeres mentés" }
      : now.getTime() - lastOk.finishedAt.getTime() > 36 * 3600_000 ? { level: "warning", detail: `Az utolsó sikeres mentés régi: ${lastOk.finishedAt.toISOString()}` }
      : last?.status === "failed" ? { level: "warning", detail: "Az utolsó mentési kísérlet sikertelen" }
      : { level: "ok", detail: `Utolsó sikeres mentés: ${lastOk.finishedAt.toISOString()}` };

    const [errs] = await db.select({ n: sql<number>`count(*)::int` }).from(errorEvents).where(gte(errorEvents.at, new Date(now.getTime() - 24 * 3600_000)));
    checks.errors = (errs?.n ?? 0) > 0 ? { level: "warning", detail: `${errs!.n} kritikus hiba az elmúlt 24 órában` } : { level: "ok", detail: "Nincs" };
  }
  const levels = Object.values(checks).map((c) => c.level);
  const overall: Level = levels.includes("error") ? "error" : levels.includes("warning") ? "warning" : "ok";
  return { overall, label: { ok: "Rendben", warning: "Figyelmeztetés", error: "Hiba" }[overall], version: cfg.APP_VERSION, checks };
}

// ---------- Adatkezelési kérelmek ----------
export async function createDataRequest(db: Db, adminId: string, kind: string, summary: string) {
  const [r] = await db.insert(dataRequests).values({ kind, summary: summary.trim(), createdBy: adminId }).returning();
  await audit(db, { actorType: "admin", actorId: adminId, action: "datarequest.create", entityType: "data_request", entityId: r!.id, after: { kind } });
  return r!;
}
export async function resolveDataRequest(db: Db, adminId: string, id: string, status: "done" | "rejected", note?: string) {
  const [r] = await db.update(dataRequests).set({ status, note: note ?? null, resolvedBy: adminId, resolvedAt: new Date() }).where(and(eq(dataRequests.id, id), eq(dataRequests.status, "open"))).returning();
  if (!r) throw new AppError("bad_state", "A kérelem nem található vagy már lezárt.", 409);
  await audit(db, { actorType: "admin", actorId: adminId, action: "datarequest.resolve", entityType: "data_request", entityId: id, after: { status } });
  return r;
}
export async function listDataRequests(db: Db) {
  return db.select().from(dataRequests).orderBy(desc(dataRequests.createdAt));
}
