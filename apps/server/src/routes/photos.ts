import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, type RouteCtx } from "../app.js";
import { AppError } from "../services/applications.js";
import {
  MAX_UPLOAD_BYTES, REPORT_REASONS, adminDeletePhoto, adminGallery, canView, decideReport, deleteOwnPhoto, getPhoto,
  listStationPhotos, photoPath, reportPhoto, uploadPhoto,
} from "../services/photos.js";

const uuid = z.string().uuid();

function participant(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { access: NonNullable<FastifyRequest["access"]> } {
  if (!req.access) { reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." }); return false; }
  return true;
}

export async function registerPhotoRoutes(app: FastifyInstance, { cfg, db, hub }: RouteCtx) {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 7 } });

  app.post("/api/access/stations/:id/photos", async (req, reply) => {
    if (!participant(req, reply) || req.access.subjectType !== "team") return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const { id } = z.object({ id: uuid }).parse(req.params);
    const part = await req.file();
    if (!part) throw new AppError("invalid_image", "Nincs kiválasztott fájl.");
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new AppError("invalid_image", "A fájl mérete legfeljebb 20 MB lehet.");
    const field = part.fields["clientId"] as { value?: string } | undefined;
    const capField = part.fields["capturedAt"] as { value?: string } | undefined;
    const capturedAt = capField?.value ? new Date(capField.value) : undefined;
    if (capturedAt && Number.isNaN(capturedAt.getTime())) throw new AppError("invalid_time", "Hibás időbélyeg.");
    const r = await uploadPhoto(db, cfg, req.access.subjectId, id, buf, { clientId: field?.value, capturedAt });
    if (!r.duplicate) hub.publish(`event:${req.access.eventId}`, "photo");
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });

  app.get("/api/access/stations/:id/photos", async (req, reply) => {
    if (!participant(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return listStationPhotos(db, { type: req.access.subjectType, id: req.access.subjectId }, id);
  });

  app.delete("/api/access/photos/:id", async (req, reply) => {
    if (!participant(req, reply) || req.access.subjectType !== "team") return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const { id } = z.object({ id: uuid }).parse(req.params);
    await deleteOwnPhoto(db, cfg, req.access.subjectId, id);
    hub.publish(`event:${req.access.eventId}`, "photo");
    return { ok: true };
  });

  app.post("/api/access/photos/:id/report", async (req, reply) => {
    if (!participant(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.enum(REPORT_REASONS), text: z.string().max(500).optional() }).parse(req.body);
    await reportPhoto(db, cfg, { type: req.access.subjectType, id: req.access.subjectId }, id, b.reason, b.text);
    hub.publish(`event:${req.access.eventId}`, "photo");
    hub.publish("admin", "photos");
    return { ok: true };
  });

  // Fájlkiszolgálás jogosultság-ellenőrzéssel (a fájlok nem publikus statikus könyvtárból jönnek)
  app.get("/api/photos/:id/:variant", async (req, reply) => {
    const { id, variant } = z.object({ id: uuid, variant: z.enum(["thumb", "full"]) }).parse(req.params);
    const viewer = req.admin ? ({ type: "admin", id: req.admin.id } as const) : req.access ? ({ type: req.access.subjectType, id: req.access.subjectId } as const) : null;
    if (!viewer) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const p = await getPhoto(db, id);
    if (!(await canView(db, viewer, p))) throw new AppError("not_found", "A fotó nem található.", 404);
    const key = variant === "thumb" ? p.thumbKey : p.fileKey;
    if (!key) throw new AppError("not_found", "A fotó nem található.", 404);
    const file = photoPath(cfg, key);
    const s = await stat(file).catch(() => null);
    if (!s) throw new AppError("not_found", "A fotó nem található.", 404);
    return reply.header("Content-Type", "image/jpeg").header("Content-Length", s.size).header("Cache-Control", "private, max-age=3600")
      .header("X-Content-Type-Options", "nosniff").send(createReadStream(file));
  });

  // ---------- Admin ----------
  app.get("/api/admin/events/:id/photos", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { filter } = z.object({ filter: z.enum(["reported"]).optional() }).parse(req.query);
    return adminGallery(db, id, filter);
  });
  app.delete("/api/admin/photos/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    await adminDeletePhoto(db, cfg, req.admin.id, id, body.reason);
    hub.publish("admin", "photos");
    return { ok: true };
  });
  app.post("/api/admin/photos/:id/decision", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(["restore", "delete"]) }).parse(req.body);
    await decideReport(db, cfg, req.admin.id, id, decision);
    hub.publish("admin", "photos");
    return { ok: true };
  });
}
