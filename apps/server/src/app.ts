import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { createLogger, redactUrl } from "./logger.js";
import type { Logger } from "pino";
import { safeEqual } from "./lib/crypto.js";
import { RealtimeHub } from "./services/realtime.js";
import { getAccessSession } from "./services/accessAuth.js";
import { getAdminSession } from "./services/adminAuth.js";
import { AuthError } from "./services/adminAuth.js";
import { AccessError } from "./services/accessAuth.js";
import { EventError } from "./services/events.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerApplicationRoutes } from "./routes/applications.js";
import { AppError } from "./services/applications.js";
import { registerStationRoutes } from "./routes/stations.js";
import { registerGameRoutes } from "./routes/game.js";
import { registerPhotoRoutes } from "./routes/photos.js";
import { registerAdminOpsRoutes } from "./routes/adminOps.js";
import { DefaultBackupRunner, type BackupRunner } from "./services/backup.js";
import { recordError } from "./services/adminOps.js";
import { GeocodeError, NominatimProvider, type GeocoderProvider } from "./services/geocode.js";

export const ADMIN_COOKIE = "th_admin";
export const ACCESS_COOKIE = "th_access";

declare module "fastify" {
  interface FastifyRequest {
    admin?: { id: string; email: string; displayName: string; csrfToken: string };
    access?: { credentialId: string; subjectType: "team" | "host"; subjectId: string; eventId: string; csrfToken: string };
  }
}

export interface AppDeps { cfg: Config; db: Db; geocoders?: GeocoderProvider[]; backupRunner?: BackupRunner; logger?: Logger }

export async function buildApp({ cfg, db, geocoders = [new NominatimProvider()], backupRunner = new DefaultBackupRunner(), logger }: AppDeps) {
  const app = Fastify({
    loggerInstance: (logger ?? createLogger(cfg.NODE_ENV === "test" ? "silent" : "info")) as unknown as FastifyBaseLogger,
    disableRequestLogging: true, // (Fastify 6-ban változik: logController) saját, token-mentes kérésnapló (lásd onResponse)
    trustProxy: true, // reverse proxy mögött a kliens IP-t az X-Forwarded-For adja
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_000_000,
  });
  const hub = new RealtimeHub();
  const secure = cfg.NODE_ENV === "production";
  // A térképcsempe-szolgáltató a TILE_URL-ből származik (csere esetén a CSP is követi); {s} aldomén helyettesítve
  const tileHost = new URL(cfg.TILE_URL.replace("{s}", "a").replace("{z}", "0").replace("{x}", "0").replace("{y}", "0")).hostname;
  const tileOrigin = cfg.TILE_URL.includes("{s}") ? `https://*.${tileHost.split(".").slice(1).join(".")}` : `https://${tileHost}`;

  await app.register(helmet, {
    // A publikus OSM csempeszerver Referer nélkül blokkol ("Access blocked"). Idegen origin felé csak az origin
    // megy ki (útvonal nem), így a belépési token az URL-ben nem szivároghat.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:", tileOrigin],
        connectSrc: ["'self'", tileOrigin],
        workerSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: secure ? [] : null,
      },
    },
  });
  await app.register(cookie);

  // Hibakezelés: nincs stack trace / belső azonosító a válaszban (spec §89)
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation", message: "Hibás adatok.", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof AuthError) return reply.code(err.code === "rate_limited" || err.code === "locked" ? 429 : 400).send({ error: err.code, message: err.message });
    if (err instanceof AccessError) return reply.code(err.code === "rate_limited" ? 429 : 400).send({ error: err.code, message: err.message });
    if (err instanceof GeocodeError) return reply.code(err.code === "rate_limited" ? 429 : 503).send({ error: err.code, message: err.message });
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof EventError) return reply.code(err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400).send({ error: err.code, message: err.message, details: err.details });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: "request", message: "Hibás kérés." });
    req.log.error({ err }, "unhandled error");
    void recordError(db, String((err as Error)?.message ?? err), req.url, String(req.id));
    return reply.code(500).send({ error: "internal", message: "Váratlan hiba történt. Kérjük, próbáld újra később." });
  });

  // CSRF: cookie-s session + állapotváltoztató metódus esetén X-CSRF-Token kötelező
  const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
  app.addHook("preHandler", async (req, reply) => {
    if (SAFE.has(req.method)) return;
    const need = req.admin?.csrfToken ?? req.access?.csrfToken;
    if (!need) return; // nincs session: publikus/login végpont (rate limitelt)
    const got = req.headers["x-csrf-token"];
    if (typeof got !== "string" || !safeEqual(got, need)) {
      return reply.code(403).send({ error: "csrf", message: "A kérés nem engedélyezett. Frissítsd az oldalt." });
    }
  });

  // Session feloldás cookie-ból
  app.addHook("onRequest", async (req) => {
    const a = await getAdminSession(db, req.cookies[ADMIN_COOKIE]);
    if (a) req.admin = { id: a.admin.id, email: a.admin.email, displayName: a.admin.displayName, csrfToken: a.session.csrfToken };
    const p = await getAccessSession(db, req.cookies[ACCESS_COOKIE]);
    if (p) {
      req.access = {
        credentialId: p.credential.id, subjectType: p.credential.subjectType as "team" | "host",
        subjectId: p.credential.subjectId, eventId: p.credential.eventId, csrfToken: p.session.csrfToken,
      };
    }
  });

  // Kérésnapló: az URL-ben lévő tokenek kitakarva, törzs és fejlécek nélkül (PIN/jelszó nem kerülhet logba)
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({ method: req.method, url: redactUrl(req.url), statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/public/config", async () => ({ tileUrl: cfg.TILE_URL, tileAttribution: cfg.TILE_ATTRIBUTION, timezone: "Europe/Budapest" }));

  const ctx: RouteCtx = { cfg, db, hub, secure, geocoders, backupRunner };
  await registerAdminRoutes(app, ctx);
  await registerAccessRoutes(app, ctx);
  await registerEventRoutes(app, ctx);
  await registerApplicationRoutes(app, ctx);
  await registerStationRoutes(app, ctx);
  await registerGameRoutes(app, ctx);
  await registerPhotoRoutes(app, ctx);
  await registerAdminOpsRoutes(app, ctx);
  // Kliens (PWA) kiszolgálása; ismeretlen, nem /api útvonalon az index.html (SPA)
  const webRoot = path.resolve(process.cwd(), cfg.WEB_DIST);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, setHeaders: (res, p) => { if (/sw\.js$|index\.html$|manifest/.test(p)) res.header("Cache-Control", "no-cache"); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found", message: "Nem található." });
      return reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
    });
  }
  return app;
}

export interface RouteCtx { cfg: Config; db: Db; hub: RealtimeHub; secure: boolean; geocoders: GeocoderProvider[]; backupRunner: BackupRunner }

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { admin: NonNullable<FastifyRequest["admin"]> } {
  if (!req.admin) {
    reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    return false;
  }
  return true;
}

export function cookieOpts(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}
