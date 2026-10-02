import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { MEMBER_CATEGORIES, PICKUP_MODES } from "@th/shared";
import { requireAdmin, type RouteCtx } from "../app.js";
import { events, hosts, teamMembers, teams } from "../db/schema.js";
import {
  AppError, approve, completePinRecovery, confirmEmailChange, getHost, getTeam, reissueAccess, reject,
  requestEmailChange, requestPinRecovery, submitHost, submitTeam, updateHost, updateTeam, withdraw,
} from "../services/applications.js";
import { ResendError, listDeliveries, manualResend } from "../services/outbox.js";
import { saveSmtp, loadSmtp } from "../services/mailer.js";
import { regenerateLink } from "../services/accessAuth.js";

const phone = z.string().min(6).max(30);
const member = z.object({ name: z.string().min(1).max(100), category: z.enum(MEMBER_CATEGORIES) });
const uuid = z.string().uuid();

function idemKey(req: FastifyRequest): string {
  const k = req.headers["idempotency-key"];
  if (typeof k !== "string" || k.length < 8 || k.length > 100) throw new AppError("idempotency_required", "Hiányzó Idempotency-Key fejléc.");
  return k;
}

function requireRole(req: FastifyRequest, reply: FastifyReply, role: "team" | "host") {
  if (!req.access || req.access.subjectType !== role) {
    reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    return false;
  }
  return true;
}

export async function registerApplicationRoutes(app: FastifyInstance, { cfg, db, hub }: RouteCtx) {
  // ---------- Publikus ----------
  const publicFields = (e: typeof events.$inferSelect) => ({
    id: e.id, name: e.name, type: e.type, shortDescription: e.shortDescription, rules: e.rules, status: e.status,
    registrationStart: e.registrationStart, registrationClose: e.registrationClose, modificationDeadline: e.modificationDeadline,
    plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, organizerContact: e.organizerContact, locality: e.locality,
    // Szándékosan nincs állomásszám, cím, koordináta vagy térkép (spec §25)
  });

  app.get("/api/public/events", async () => {
    const rows = await db.select().from(events).where(inArray(events.status, ["registration_open", "preparation", "active"])).orderBy(events.plannedStart);
    return rows.map(publicFields);
  });
  app.get("/api/public/events/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [e] = await db.select().from(events).where(and(eq(events.id, id), inArray(events.status, ["registration_open", "preparation", "active"])));
    if (!e) throw new AppError("not_found", "Az esemény nem található.", 404);
    return publicFields(e);
  });

  app.post("/api/public/events/:id/teams", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      name: z.string().min(1).max(100), contactName: z.string().min(1).max(100), email: z.string().email().max(200), phone,
      members: z.array(member).min(1).max(100), consent: z.boolean(),
    }).parse(req.body);
    const r = await submitTeam(db, cfg, id, b, idemKey(req));
    hub.publish("admin", "applications");
    return reply.code(r.duplicate ? 200 : 201).send({ id: r.id, status: "pending" });
  });

  app.post("/api/public/events/:id/hosts", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      contactName: z.string().min(1).max(100), email: z.string().email().max(200), phone, address: z.string().min(5).max(300),
      pickupMode: z.enum(PICKUP_MODES), participantNote: z.string().max(500).optional(), consent: z.boolean(),
      location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), placeId: z.string().max(300).optional() }).optional(),
    }).parse(req.body);
    const r = await submitHost(db, cfg, id, b, idemKey(req));
    hub.publish("admin", "applications");
    return reply.code(r.duplicate ? 200 : 201).send({ id: r.id, status: "pending" });
  });

  app.post("/api/public/pin-recovery/request", async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await requestPinRecovery(db, cfg, email, req.ip);
    return { ok: true, message: "Ha van ilyen jóváhagyott jelentkezés, elküldtük a visszaállító linket." };
  });
  app.post("/api/public/pin-recovery/complete", async (req) => {
    const b = z.object({ token: z.string().min(10), pin: z.string(), pinAgain: z.string() }).parse(req.body);
    await completePinRecovery(db, b.token, b.pin, b.pinAgain);
    return { ok: true };
  });
  app.post("/api/public/email-change/confirm", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    await confirmEmailChange(db, token);
    return { ok: true };
  });

  // ---------- Csapat (résztvevő) ----------
  app.get("/api/access/team", async (req, reply) => {
    if (!requireRole(req, reply, "team")) return;
    return getTeam(db, req.access!.subjectId);
  });
  app.patch("/api/access/team", async (req, reply) => {
    if (!requireRole(req, reply, "team")) return;
    const b = z.object({ name: z.string().min(1).max(100), contactName: z.string().min(1).max(100), phone, members: z.array(member).min(1).max(100) }).partial().parse(req.body);
    await updateTeam(db, req.access!.subjectId, b);
    hub.publish("admin", "applications");
    return getTeam(db, req.access!.subjectId);
  });
  app.post("/api/access/team/email-change", async (req, reply) => {
    if (!requireRole(req, reply, "team")) return;
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await requestEmailChange(db, cfg, "team", req.access!.subjectId, email);
    return { ok: true };
  });
  app.post("/api/access/team/withdraw", async (req, reply) => {
    if (!requireRole(req, reply, "team")) return;
    const { confirm } = z.object({ confirm: z.boolean() }).parse(req.body);
    await withdraw(db, cfg, "team", req.access!.subjectId, confirm);
    reply.clearCookie("th_access", { path: "/" });
    hub.publish("admin", "applications");
    return { ok: true };
  });

  // ---------- Host (résztvevő) ----------
  app.get("/api/access/host", async (req, reply) => {
    if (!requireRole(req, reply, "host")) return;
    return getHost(db, req.access!.subjectId);
  });
  app.patch("/api/access/host", async (req, reply) => {
    if (!requireRole(req, reply, "host")) return;
    const b = z.object({
      contactName: z.string().min(1).max(100), phone, address: z.string().min(5).max(300),
      pickupMode: z.enum(PICKUP_MODES), participantNote: z.string().max(500),
    }).partial().parse(req.body);
    const r = await updateHost(db, cfg, req.access!.subjectId, b);
    hub.publish("admin", "applications");
    return { ...r, host: await getHost(db, req.access!.subjectId) };
  });
  app.post("/api/access/host/email-change", async (req, reply) => {
    if (!requireRole(req, reply, "host")) return;
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await requestEmailChange(db, cfg, "host", req.access!.subjectId, email);
    return { ok: true };
  });
  app.post("/api/access/host/withdraw", async (req, reply) => {
    if (!requireRole(req, reply, "host")) return;
    const { confirm } = z.object({ confirm: z.boolean() }).parse(req.body);
    await withdraw(db, cfg, "host", req.access!.subjectId, confirm);
    reply.clearCookie("th_access", { path: "/" });
    hub.publish("admin", "applications");
    return { ok: true };
  });

  // ---------- Admin ----------
  app.get("/api/admin/events/:id/teams", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const rows = await db.select().from(teams).where(eq(teams.eventId, id)).orderBy(teams.createdAt);
    const counts = await db.select({
      teamId: teamMembers.teamId, children: sql<number>`count(*) filter (where ${teamMembers.category} = 'child')::int`, total: sql<number>`count(*)::int`,
    }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(eq(teams.eventId, id)).groupBy(teamMembers.teamId);
    const byTeam = new Map(counts.map((c) => [c.teamId, c]));
    return rows.map((t) => ({ ...t, children: byTeam.get(t.id)?.children ?? 0, adults: (byTeam.get(t.id)?.total ?? 0) - (byTeam.get(t.id)?.children ?? 0) }));
  });
  app.get("/api/admin/events/:id/hosts", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return db.select().from(hosts).where(eq(hosts.eventId, id)).orderBy(hosts.createdAt);
  });

  for (const type of ["team", "host"] as const) {
    const base = `/api/admin/${type}s/:id`;
    app.post(`${base}/approve`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      const r = await approve(db, cfg, req.admin.id, type, id);
      hub.publish("admin", "applications");
      return r;
    });
    app.post(`${base}/reject`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { reason } = z.object({ reason: z.string() }).parse(req.body);
      await reject(db, cfg, req.admin.id, type, id, reason);
      hub.publish("admin", "applications");
      return { ok: true };
    });
    // Csak a link cserélődik (a régi azonnal érvénytelen), a PIN és a már bejelentkezett munkamenetek maradnak.
    // Az új link egyszer, a válaszban látszik; az admin juttatja el a résztvevőnek.
    app.post(`${base}/regenerate-link`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      const { token } = await regenerateLink(db, type, id, req.admin.id);
      return { link: `${cfg.PUBLIC_BASE_URL}/belepes/${token}` };
    });
    app.post(`${base}/reissue-access`, async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const { id } = z.object({ id: uuid }).parse(req.params);
      await reissueAccess(db, cfg, req.admin.id, type, id);
      return { ok: true };
    });
  }

  app.get("/api/admin/emails", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listDeliveries(db);
  });
  app.post("/api/admin/emails/:id/resend", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      await manualResend(db, req.admin.id, id);
    } catch (e) {
      if (e instanceof ResendError) return reply.code(e.code === "rate_limited" ? 429 : e.code === "not_found" ? 404 : 409).send({ error: e.code, message: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.get("/api/admin/settings/smtp", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = await loadSmtp(db, cfg);
    return s ? { ...s, password: s.password ? "********" : "" } : null; // a jelszó sosem hagyja el a szervert
  });
  app.put("/api/admin/settings/smtp", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({
      host: z.string().min(1), port: z.number().int().min(1).max(65535), secure: z.boolean(), username: z.string(),
      password: z.string(), senderName: z.string().min(1), senderEmail: z.string().email(),
    }).parse(req.body);
    const existing = await loadSmtp(db, cfg);
    await saveSmtp(db, cfg, { ...b, password: b.password === "********" && existing ? existing.password : b.password });
    return { ok: true };
  });
}
