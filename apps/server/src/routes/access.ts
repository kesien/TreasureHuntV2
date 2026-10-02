import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACCESS_COOKIE, cookieOpts, type RouteCtx } from "../app.js";
import { accessLogin, accessLogout, changePin } from "../services/accessAuth.js";

export async function registerAccessRoutes(app: FastifyInstance, { db, secure }: RouteCtx) {
  app.post("/api/access/login", async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(100), pin: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const r = await accessLogin(db, b.token, b.pin, req.ip, req.headers["user-agent"]);
    // Az eszköz megjegyzi a sessiont (hosszú élettartamú süti); a hozzáférést az esemény lejárata szünteti meg.
    reply.setCookie(ACCESS_COOKIE, r.sessionToken, { ...cookieOpts(secure), maxAge: 60 * 60 * 24 * 90 });
    return { csrfToken: r.csrfToken, role: r.subjectType };
  });

  app.get("/api/access/me", async (req, reply) => {
    if (!req.access) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    return { role: req.access.subjectType, csrfToken: req.access.csrfToken };
  });

  // Csak az aktuális eszköz kilép
  app.post("/api/access/logout", async (req, reply) => {
    if (!req.access) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    await accessLogout(db, req.cookies[ACCESS_COOKIE]!);
    reply.clearCookie(ACCESS_COOKIE, { path: "/" });
    return { ok: true };
  });

  // PIN módosítás belépve; minden session (ezt is) érvénytelen lesz
  app.post("/api/access/change-pin", async (req, reply) => {
    if (!req.access) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const b = z.object({ newPin: z.string(), newPinAgain: z.string() }).parse(req.body);
    if (b.newPin !== b.newPinAgain) return reply.code(400).send({ error: "mismatch", message: "A két PIN nem egyezik." });
    await changePin(db, req.access.subjectType, req.access.subjectId, b.newPin, { type: req.access.subjectType, id: req.access.subjectId });
    reply.clearCookie(ACCESS_COOKIE, { path: "/" });
    return { ok: true };
  });
}
