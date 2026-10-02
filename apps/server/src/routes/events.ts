import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EVENT_STATUSES, EVENT_TYPES } from "@th/shared";
import { requireAdmin, type RouteCtx } from "../app.js";
import { createEvent, deleteEmptyDraft, getEvent, listEvents, refreshEventCenter, transitionEvent, updateEvent } from "../services/events.js";

const date = z.coerce.date();
const eventBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(EVENT_TYPES),
  shortDescription: z.string().max(1000).optional(),
  rules: z.string().max(50_000).optional(),
  registrationStart: date,
  registrationClose: date,
  modificationDeadline: date,
  plannedStart: date,
  plannedEnd: date,
  checkinRadiusM: z.number().int().min(10).max(1000).optional(),
  organizerContact: z.string().max(500).optional(),
  locality: z.string().trim().max(100).optional(),
});

export async function registerEventRoutes(app: FastifyInstance, { cfg, db, hub, geocoders }: RouteCtx) {
  app.get("/api/admin/events", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listEvents(db);
  });

  app.get("/api/admin/events/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getEvent(db, id);
  });

  app.post("/api/admin/events", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = eventBody.parse(req.body);
    const created = await createEvent(db, req.admin.id, body);
    if (body.locality) await refreshEventCenter(db, geocoders, created.id);
    const ev = await getEvent(db, created.id);
    hub.publish("admin", "events");
    return reply.code(201).send(ev);
  });

  app.patch("/api/admin/events/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = eventBody.partial().parse(req.body);
    const r = await updateEvent(db, req.admin.id, id, patch);
    if (patch.locality !== undefined) await refreshEventCenter(db, geocoders, id);
    hub.publish("admin", "events");
    hub.publish(`event:${id}`, "event");
    return r;
  });

  app.post("/api/admin/events/:id/transition", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.enum(EVENT_STATUSES), reason: z.string().max(1000).optional() }).parse(req.body);
    const r = await transitionEvent(db, req.admin.id, id, b.to, b.reason, cfg);
    hub.publish("admin", "events");
    hub.publish(`event:${id}`, "event");
    return r;
  });

  app.delete("/api/admin/events/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await deleteEmptyDraft(db, req.admin.id, id);
    hub.publish("admin", "events");
    return { ok: true };
  });

  // Admin SSE (csak jelzés, az adat a normál API-ból jön)
  app.get("/api/admin/stream", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    reply.hijack();
    hub.subscribe("admin", reply.raw);
  });
}
