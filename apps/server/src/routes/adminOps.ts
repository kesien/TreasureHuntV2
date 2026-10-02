import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { MEMBER_CATEGORIES, PICKUP_MODES } from "@th/shared";
import { requireAdmin, type RouteCtx } from "../app.js";
import { stations } from "../db/schema.js";
import { AppError, getHost, getTeam, removeFromEvent, updateHost, updateTeam } from "../services/applications.js";
import { audit } from "../services/audit.js";
import { hostDashboard, teamProgress } from "../services/checkins.js";
import { createDataRequest, eventStats, listDataRequests, queryAudit, resolveDataRequest, systemStatus } from "../services/adminOps.js";
import { listBackupRuns, runBackup } from "../services/backup.js";
import { giftSummary } from "../services/gifts.js";
import { anonymizeHost, anonymizeTeam } from "../services/retention.js";
import { stationsForParticipant } from "../services/stations.js";
import { teams, hosts } from "../db/schema.js";

const uuid = z.string().uuid();

export async function registerAdminOpsRoutes(app: FastifyInstance, { cfg, db, hub, backupRunner }: RouteCtx) {
  app.get("/api/admin/events/:id/stats", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return eventStats(db, id);
  });

  // Admin térkép: állomások státusszal (nincs élő csapatkövetés)
  app.get("/api/admin/events/:id/map", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const rows = await db.select().from(stations).where(eq(stations.eventId, id)).orderBy(stations.number);
    const out = [];
    for (const s of rows) {
      const g = s.status === "active" ? await giftSummary(db, s.id) : null;
      out.push({
        id: s.id, number: s.number, address: s.address, latitude: s.latitude, longitude: s.longitude, virtual: s.hostId === null, status: s.status,
        gift: g ? { status: g.status, reports: g.reports, likelyOut: g.likelyOut } : null,
      });
    }
    return out;
  });

  app.get("/api/admin/audit", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = z.object({
      q: z.string().max(100).optional(), action: z.string().max(100).optional(), entityType: z.string().max(50).optional(), actorId: uuid.optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);
    return queryAudit(db, q);
  });

  app.get("/api/admin/system-status", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return systemStatus(db, cfg);
  });

  // ---------- Mentés (nincs UI-s visszaállítás; a restore dokumentált kézi folyamat) ----------
  app.get("/api/admin/backups", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listBackupRuns(db);
  });
  app.post("/api/admin/backups", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const r = await runBackup(db, cfg, backupRunner, "manual", { actorId: req.admin.id });
    hub.publish("admin", "backups");
    return reply.code(r.status === "ok" ? 201 : 500).send(r.status === "ok" ? r : { ...r, error: "backup_failed", message: "A mentés nem sikerült. A részletek a mentések listájában láthatók." });
  });

  // ---------- Adatkezelési kérelmek ----------
  app.get("/api/admin/data-requests", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listDataRequests(db);
  });
  app.post("/api/admin/data-requests", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ kind: z.enum(["access", "rectification", "erasure", "anonymization"]), summary: z.string().min(3).max(500) }).parse(req.body);
    return reply.code(201).send(await createDataRequest(db, req.admin.id, b.kind, b.summary));
  });
  app.post("/api/admin/data-requests/:id/resolve", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ status: z.enum(["done", "rejected"]), note: z.string().max(500).optional() }).parse(req.body);
    return resolveDataRequest(db, req.admin.id, id, b.status, b.note);
  });

  // ---------- Admin módosítások / műveletek ----------
  app.patch("/api/admin/teams/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      name: z.string().min(1).max(100), contactName: z.string().min(1).max(100), phone: z.string().min(6).max(30),
      members: z.array(z.object({ name: z.string().min(1).max(100), category: z.enum(MEMBER_CATEGORIES) })).min(1).max(100),
    }).partial().parse(req.body);
    await updateTeam(db, id, b, req.admin.id);
    hub.publish("admin", "applications");
    return getTeam(db, id);
  });
  app.patch("/api/admin/hosts/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      contactName: z.string().min(1).max(100), phone: z.string().min(6).max(30), address: z.string().min(5).max(300),
      pickupMode: z.enum(PICKUP_MODES), participantNote: z.string().max(500),
    }).partial().parse(req.body);
    const r = await updateHost(db, cfg, id, b, req.admin.id);
    hub.publish("admin", "applications");
    return r;
  });
  for (const type of ["team", "host"] as const) {
    app.post(`/api/admin/${type}s/:id/remove`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { reason } = z.object({ reason: z.string() }).parse(req.body);
      await removeFromEvent(db, req.admin.id, type, id, reason);
      hub.publish("admin", "applications");
      return { ok: true };
    });
    // Adatkezelési kérelem alapján: személyes adatok törlése (a státusz és az aggregált adat marad)
    app.post(`/api/admin/${type}s/:id/anonymize`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
      const [row] = type === "team" ? await db.select({ eventId: teams.eventId }).from(teams).where(eq(teams.id, id)) : await db.select({ eventId: hosts.eventId }).from(hosts).where(eq(hosts.id, id));
      if (!row) throw new AppError("not_found", "Nem található.", 404);
      if (type === "team") await anonymizeTeam(db, id); else await anonymizeHost(db, id);
      await audit(db, { actorType: "admin", actorId: req.admin.id, action: `${type}.anonymize`, entityType: type, entityId: id, eventId: row.eventId, reason });
      return { ok: true };
    });
  }

  // ---------- Megtekintés csapatként / hostként: csak olvasható, munkamenet nélkül, auditált ----------
  app.get("/api/admin/view-as/team/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const team = await getTeam(db, id);
    await audit(db, { actorType: "admin", actorId: req.admin.id, action: "admin.view_as", entityType: "team", entityId: id });
    return { readOnly: true, team, progress: await teamProgress(db, id), stations: await stationsForParticipant(db, team.event.id) };
  });
  app.get("/api/admin/view-as/host/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const host = await getHost(db, id);
    await audit(db, { actorType: "admin", actorId: req.admin.id, action: "admin.view_as", entityType: "host", entityId: id });
    return { readOnly: true, host, dashboard: await hostDashboard(db, id) };
  });
}
