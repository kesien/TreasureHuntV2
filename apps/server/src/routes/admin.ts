import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ADMIN_COOKIE, cookieOpts, requireAdmin, type RouteCtx } from "../app.js";
import { admins } from "../db/schema.js";
import { enqueueEmail } from "../services/outbox.js";
import {
  adminLogin, adminLogout, beginActivation, completeActivation, completePasswordReset,
  inviteAdmin, requestPasswordReset, setAdminArchived,
} from "../services/adminAuth.js";

export async function registerAdminRoutes(app: FastifyInstance, { cfg, db, secure }: RouteCtx) {
  app.post("/api/admin/login", async (req, reply) => {
    const body = z.object({
      email: z.string().email(), password: z.string().min(1),
      totp: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().max(20).optional(),
    }).refine((b) => b.totp || b.recoveryCode, { message: "Add meg a hitelesítő kódot." }).parse(req.body);
    const r = await adminLogin(db, cfg, body, req.ip);
    reply.setCookie(ADMIN_COOKIE, r.sessionToken, { ...cookieOpts(secure), maxAge: 8 * 3600 });
    return { csrfToken: r.csrfToken };
  });

  app.post("/api/admin/logout", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    await adminLogout(db, req.cookies[ADMIN_COOKIE]!, req.admin.id);
    reply.clearCookie(ADMIN_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/admin/me", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { id: req.admin.id, email: req.admin.email, displayName: req.admin.displayName, csrfToken: req.admin.csrfToken };
  });

  // Meghívó aktiváció: 1. lépés TOTP secret, 2. lépés jelszó + kód
  app.post("/api/admin/activation/begin", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    return beginActivation(db, cfg, token);
  });
  app.post("/api/admin/activation/complete", async (req) => {
    const b = z.object({ token: z.string().min(10), password: z.string(), totp: z.string().regex(/^\d{6}$/) }).parse(req.body);
    return completeActivation(db, cfg, b.token, b.password, b.totp);
  });

  // Jelszó-visszaállítás: mindig azonos válasz
  app.post("/api/admin/password-reset/request", async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const r = await requestPasswordReset(db, email, req.ip);
    if (r) await enqueueEmail(db, cfg, { type: "password_reset", recipient: email, data: { link: `${cfg.PUBLIC_BASE_URL}/admin/jelszo-visszaallitas?token=${r.token}` }, dedupKey: `password_reset:${r.adminId}:${r.token.slice(0, 10)}`, entityType: "admin", entityId: r.adminId });
    return { ok: true, message: "Ha létezik ilyen fiók, elküldtük a visszaállító linket." };
  });
  app.post("/api/admin/password-reset/complete", async (req) => {
    const b = z.object({ token: z.string().min(10), password: z.string() }).parse(req.body);
    await completePasswordReset(db, b.token, b.password);
    return { ok: true };
  });

  app.post("/api/admin/admins/invite", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = z.object({ email: z.string().email(), displayName: z.string().min(1).max(100) }).parse(req.body);
    const r = await inviteAdmin(db, req.admin.id, b.email, b.displayName);
    await enqueueEmail(db, cfg, { type: "admin_invitation", recipient: b.email, data: { link: `${cfg.PUBLIC_BASE_URL}/admin/activate?token=${r.token}` }, dedupKey: `admin_invitation:${r.adminId}:${r.token.slice(0, 10)}`, entityType: "admin", entityId: r.adminId });
    return { adminId: r.adminId };
  });

  app.get("/api/admin/admins", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await db.select({ id: admins.id, email: admins.email, displayName: admins.displayName, status: admins.status }).from(admins);
    return rows;
  });

  app.post("/api/admin/admins/:id/archive", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await setAdminArchived(db, req.admin.id, id, true);
    return { ok: true };
  });
  app.post("/api/admin/admins/:id/restore", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await setAdminArchived(db, req.admin.id, id, false);
    return { ok: true };
  });
}
