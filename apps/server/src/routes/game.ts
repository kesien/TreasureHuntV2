import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, type RouteCtx } from "../app.js";
import { AppError } from "../services/applications.js";
import { checkIn, hostDashboard, manualCheckIn, teamProgress } from "../services/checkins.js";
import { decideReview, listReviews, syncCheckIns } from "../services/sync.js";
import { adminGiftHistory, giftSummary, markDepleted, reportOutOfGifts, restock } from "../services/gifts.js";

const uuid = z.string().uuid();

function role(req: FastifyRequest, reply: FastifyReply, r: "team" | "host") {
  if (req.access?.subjectType !== r) { reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." }); return false; }
  return true;
}

export async function registerGameRoutes(app: FastifyInstance, { cfg, db, hub }: RouteCtx) {
  // Valós idejű jelzések a résztvevőknek (csak "változott" jelzés; az adatot a normál API adja)
  app.get("/api/access/stream", async (req, reply) => {
    if (!req.access) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    reply.hijack();
    hub.subscribe(`event:${req.access.eventId}`, reply.raw);
  });

  // ---------- Csapat ----------
  app.post("/api/access/checkin", async (req, reply) => {
    if (!role(req, reply, "team")) return;
    const b = z.object({ stationId: uuid, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).nullable().optional() }).parse(req.body);
    const r = await checkIn(db, req.access!.subjectId, b.stationId, b.latitude, b.longitude, b.accuracy ?? null);
    if (r.result === "ok" && !r.alreadyCheckedIn) hub.publish(`event:${req.access!.eventId}`, "checkin");
    return r;
  });

  app.get("/api/access/progress", async (req, reply) => {
    if (!role(req, reply, "team")) return;
    return teamProgress(db, req.access!.subjectId);
  });

  app.post("/api/access/stations/:id/out-of-gifts", async (req, reply) => {
    if (!role(req, reply, "team")) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await reportOutOfGifts(db, cfg, req.access!.subjectId, id);
    hub.publish(`event:${req.access!.eventId}`, "gift");
    return { alreadyReported: r.alreadyReported, likelyOut: r.likelyOut };
  });

  // Offline queue szinkron: elemenként független, idempotens feldolgozás; a szerver újraellenőriz mindent
  app.post("/api/access/sync/checkins", async (req, reply) => {
    if (!role(req, reply, "team")) return;
    const b = z.object({ items: z.array(z.object({
      clientId: z.string().min(8).max(100), stationId: uuid, capturedAt: z.coerce.date(),
      latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).nullable().optional(),
    })).max(50) }).parse(req.body);
    const results = await syncCheckIns(db, cfg, req.access!.subjectId, b.items.map((i) => ({ ...i, accuracy: i.accuracy ?? null })));
    if (results.some((r) => r.status === "accepted")) hub.publish(`event:${req.access!.eventId}`, "checkin");
    return { results, serverTime: new Date() };
  });

  // ---------- Host ----------
  app.get("/api/access/host/dashboard", async (req, reply) => {
    if (!role(req, reply, "host")) return;
    return hostDashboard(db, req.access!.subjectId);
  });
  app.post("/api/access/host/gift/depleted", async (req, reply) => {
    if (!role(req, reply, "host")) return;
    const { stationId, note } = z.object({ stationId: uuid, note: z.string().max(300).optional() }).parse(req.body);
    const r = await markDepleted(db, { type: "host", id: req.access!.subjectId }, stationId, note ?? null);
    hub.publish(`event:${req.access!.eventId}`, "gift");
    return r;
  });
  app.post("/api/access/host/gift/restock", async (req, reply) => {
    if (!role(req, reply, "host")) return;
    const { stationId } = z.object({ stationId: uuid }).parse(req.body);
    const r = await restock(db, { type: "host", id: req.access!.subjectId }, stationId);
    hub.publish(`event:${req.access!.eventId}`, "gift");
    return r;
  });

  // ---------- Admin ----------
  app.post("/api/admin/checkins", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ teamId: uuid, stationId: uuid, at: z.coerce.date(), reason: z.string() }).parse(req.body);
    await manualCheckIn(db, req.admin.id, b.teamId, b.stationId, b.at, b.reason);
    hub.publish("admin", "checkins");
    return { ok: true };
  });
  app.get("/api/admin/events/:id/reviews", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return listReviews(db, id);
  });
  app.post("/api/admin/checkins/:id/review", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ decision: z.enum(["accept", "reject"]), reason: z.string().max(500).optional() }).parse(req.body);
    await decideReview(db, req.admin.id, id, b.decision, b.reason);
    hub.publish("admin", "checkins");
    return { ok: true };
  });
  app.get("/api/admin/teams/:id/progress", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return teamProgress(db, id);
  });
  app.get("/api/admin/stations/:id/gifts", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { current: await giftSummary(db, id), history: await adminGiftHistory(db, id) };
  });
  app.post("/api/admin/stations/:id/gifts", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ action: z.enum(["depleted", "restock"]), reason: z.string(), note: z.string().max(300).optional() }).parse(req.body);
    const actor = { type: "admin" as const, id: req.admin.id };
    if (b.action === "depleted") await markDepleted(db, actor, id, b.note ?? null, b.reason);
    else await restock(db, actor, id, b.reason);
    hub.publish("admin", "gifts");
    return giftSummary(db, id);
  });
  void AppError;
}
