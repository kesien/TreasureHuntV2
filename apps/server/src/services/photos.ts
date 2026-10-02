import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import decodeHeic from "heic-decode";
import { MAX_PHOTOS_PER_TEAM_STATION } from "@th/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { checkIns, events, hosts, photoReports, photos, stations, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { AppError } from "./applications.js";
import { notifyAdmins } from "./outbox.js";
import { hit } from "./rateLimit.js";
import { photoPath } from "./photoFiles.js";
import { judgeTimestamp } from "./sync.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DIMENSION = 2560;
const THUMB_DIMENSION = 400;
/** Dekompressziós bomba elleni korlát: ennyi pixelnél nagyobb képet nem dolgozunk fel. */
export const MAX_PIXELS = 64_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
export const REPORT_REASONS = ["child_privacy", "offensive", "accidental", "other"] as const;

// Egyszerre legfeljebb 2 képfeldolgozás (memória/CPU védelem kis szerveren)
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

export interface ProcessedImage { full: Buffer; thumb: Buffer; width: number; height: number }

/**
 * Tartalom alapú ellenőrzés (nem a kiterjesztés), pixelkorlát, EXIF/GPS eltávolítás, átméretezés.
 * A kimenet mindig újrakódolt JPEG, így az eredeti (nagy, metaadatos) fájl nem marad meg.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length === 0 || input.length > MAX_UPLOAD_BYTES) throw new AppError("invalid_image", "A fájl mérete legfeljebb 20 MB lehet.");
  const type = await fileTypeFromBuffer(input);
  if (!type || !ALLOWED_MIME.has(type.mime)) throw new AppError("invalid_image", "Csak JPEG, PNG, WebP vagy HEIC/HEIF kép tölthető fel.");
  try {
    let pipeline: ReturnType<typeof sharp>;
    if (type.mime === "image/heic" || type.mime === "image/heif") {
      const images = await decodeHeic.all({ buffer: input });
      const first = images[0];
      if (!first) throw new Error("empty heic");
      if (first.width * first.height > MAX_PIXELS) throw new AppError("invalid_image", "A kép felbontása túl nagy.");
      const raw = await first.decode(); // a libheif az elforgatást már alkalmazza
      pipeline = sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: MAX_PIXELS });
    } else {
      pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate(); // EXIF tájolás alkalmazása a törlés előtt
    }
    const base = pipeline.flatten({ background: "#ffffff" }); // átlátszóság → fehér (JPEG)
    const { data: full, info } = await base.clone().resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true }); // metaadat alapból nem kerül a kimenetbe
    const thumb = await base.clone().resize({ width: THUMB_DIMENSION, height: THUMB_DIMENSION, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    return { full, thumb, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("invalid_image", "A kép nem dolgozható fel. Próbálj másik fényképet.");
  }
}

export { photoPath };

async function removeFiles(cfg: Config, row: { fileKey: string | null; thumbKey: string | null }) {
  for (const k of [row.fileKey, row.thumbKey]) if (k) await rm(photoPath(cfg, k), { force: true });
}

export async function uploadPhoto(db: Db, cfg: Config, teamId: string, stationId: string, data: Buffer, opts: { clientId?: string; capturedAt?: Date } = {}) {
  if (!(await hit(db, "photo_upload", teamId, 40, 600))) throw new AppError("rate_limited", "Túl sok feltöltés. Próbáld újra később.", 429);
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!team || !st || st.eventId !== team.eventId) throw new AppError("not_found", "Az állomás nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, team.eventId));
  // Offline szinkron: eredeti időbélyeggel érkező fotó; esemény lezárása után is elfogadható (review szabályokkal)
  const offline = !!(opts.clientId && opts.capturedAt);
  const evOk = ev?.status === "active" || (offline && ev?.status === "closed");
  if (!evOk || team.status !== "approved") throw new AppError("not_active", "Fotót most nem lehet feltölteni.", 409);
  if (st.status !== "active" && !offline) throw new AppError("station_removed", "Ez az állomás már nem része az eseménynek.", 409);
  const [ci] = await db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), eq(checkIns.stationId, stationId), offline ? inArray(checkIns.status, ["accepted", "needs_review"]) : eq(checkIns.status, "accepted")));
  if (!ci) throw new AppError("checkin_required", "Fotót csak az állomáson történt becsekkolás után lehet feltölteni.", 409);
  const now0 = new Date();
  const originalAt = offline ? opts.capturedAt! : now0;
  let reviewReason: string | null = null;
  if (offline) {
    reviewReason = ci.status === "needs_review" ? "checkin_needs_review" : st.status !== "active" ? "station_removed" : judgeTimestamp(ev!, originalAt, now0);
  }

  if (opts.clientId) {
    const [dup] = await db.select().from(photos).where(and(eq(photos.teamId, teamId), eq(photos.clientId, opts.clientId)));
    if (dup) return { id: dup.id, duplicate: true, status: dup.status };
  }
  const img = await withSlot(() => processImage(data));
  const id = randomUUID();
  const fileKey = `${ev!.id}/${id}.jpg`;
  const thumbKey = `${ev!.id}/${id}_t.jpg`;
  await mkdir(path.dirname(photoPath(cfg, fileKey)), { recursive: true });
  await writeFile(photoPath(cfg, fileKey), img.full);
  await writeFile(photoPath(cfg, thumbKey), img.thumb);
  try {
    await db.transaction(async (tx) => {
      // A csapat sorának zárolásával a párhuzamos feltöltések sem léphetik át az 5 fotós korlátot
      await tx.execute(sql`select id from teams where id = ${teamId} for update`);
      const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.teamId, teamId), eq(photos.stationId, stationId), sql`${photos.status} not in ('deleted','rejected')`));
      if ((c?.n ?? 0) >= MAX_PHOTOS_PER_TEAM_STATION) throw new AppError("photo_limit", `Állomásonként legfeljebb ${MAX_PHOTOS_PER_TEAM_STATION} fotó tölthető fel.`, 409);
      await tx.insert(photos).values({
        id, eventId: ev!.id, teamId, stationId, fileKey, thumbKey, width: img.width, height: img.height, bytes: img.full.length,
        clientId: opts.clientId ?? null, originalAt, receivedAt: new Date(), status: reviewReason ? "pending_review" : "visible", reviewReason,
      });
    });
  } catch (e) {
    await rm(photoPath(cfg, fileKey), { force: true });
    await rm(photoPath(cfg, thumbKey), { force: true });
    throw e;
  }
  return { id, duplicate: false, status: reviewReason ? "pending_review" : "visible" };
}

type Viewer = { type: "team" | "host"; id: string } | { type: "admin"; id: string };

/** Ki láthat egy fotót: admin mindent; a team az állomásán becsekkolt vagy saját fotót; a host a saját állomását. Rejtett csak adminnak. */
export async function canView(db: Db, v: Viewer, photo: typeof photos.$inferSelect): Promise<boolean> {
  if (v.type === "admin") return photo.status !== "deleted";
  if (photo.status !== "visible") return false;
  if (v.type === "host") {
    const [st] = await db.select({ hostId: stations.hostId }).from(stations).where(eq(stations.id, photo.stationId));
    return st?.hostId === v.id;
  }
  if (photo.teamId === v.id) return true;
  const [ci] = await db.select({ id: checkIns.id }).from(checkIns).where(and(eq(checkIns.teamId, v.id), eq(checkIns.stationId, photo.stationId), eq(checkIns.status, "accepted")));
  return !!ci;
}

export async function getPhoto(db: Db, id: string) {
  const [p] = await db.select().from(photos).where(eq(photos.id, id));
  if (!p) throw new AppError("not_found", "A fotó nem található.", 404);
  return p;
}

/** Résztvevői galéria egy állomáshoz: anonim (nincs csapatnév), rejtett nélkül. */
export async function listStationPhotos(db: Db, v: { type: "team" | "host"; id: string }, stationId: string) {
  const [st] = await db.select().from(stations).where(eq(stations.id, stationId));
  if (!st) throw new AppError("not_found", "Az állomás nem található.", 404);
  if (v.type === "host" && st.hostId !== v.id) throw new AppError("forbidden", "Ez nem a te állomásod.", 403);
  if (v.type === "team") {
    const [ci] = await db.select({ id: checkIns.id }).from(checkIns).where(and(eq(checkIns.teamId, v.id), eq(checkIns.stationId, stationId), eq(checkIns.status, "accepted")));
    if (!ci) throw new AppError("checkin_required", "A galéria az állomáson történt becsekkolás után érhető el.", 403);
  }
  const rows = await db.select().from(photos).where(and(eq(photos.stationId, stationId), eq(photos.status, "visible"))).orderBy(photos.receivedAt);
  return rows.map((p) => ({
    id: p.id, thumbUrl: `/api/photos/${p.id}/thumb`, url: `/api/photos/${p.id}/full`, width: p.width, height: p.height,
    mine: v.type === "team" && p.teamId === v.id, createdAt: p.receivedAt,
  }));
}

/** A csapat a saját fotóját bármikor törölheti (határidő után is). */
export async function deleteOwnPhoto(db: Db, cfg: Config, teamId: string, photoId: string) {
  const p = await getPhoto(db, photoId);
  if (p.teamId !== teamId || p.status === "deleted") throw new AppError("not_found", "A fotó nem található.", 404);
  await removeFiles(cfg, p);
  await db.update(photos).set({ status: "deleted", fileKey: null, thumbKey: null, deletedAt: new Date(), deletedBy: "team" }).where(eq(photos.id, photoId));
  await audit(db, { actorType: "team", actorId: teamId, action: "photo.delete", entityType: "photo", entityId: photoId, eventId: p.eventId });
}

export async function adminDeletePhoto(db: Db, cfg: Config, adminId: string, photoId: string, reason?: string) {
  const p = await getPhoto(db, photoId);
  if (p.status === "deleted") throw new AppError("bad_state", "A fotó már törölve van.", 409);
  await removeFiles(cfg, p);
  await db.transaction(async (tx) => {
    await tx.update(photos).set({ status: "deleted", fileKey: null, thumbKey: null, deletedAt: new Date(), deletedBy: "admin" }).where(eq(photos.id, photoId));
    // Nyitott jelentésekre rögzítjük a döntést (a jelentések története megmarad)
    await tx.update(photoReports).set({ decision: "deleted", decidedBy: adminId, decidedAt: new Date() }).where(and(eq(photoReports.photoId, photoId), sql`${photoReports.decision} is null`));
    await audit(tx, { actorType: "admin", actorId: adminId, action: p.status === "hidden_reported" ? "photo.moderation_delete" : "photo.delete", entityType: "photo", entityId: photoId, eventId: p.eventId, reason });
  });
}

/** Jelentés: a fotó azonnal eltűnik minden résztvevő elől; az admin értesítést kap. */
export async function reportPhoto(db: Db, cfg: Config, reporter: { type: "team" | "host"; id: string }, photoId: string, reason: string, text?: string) {
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw new AppError("invalid_reason", "Ismeretlen jelentési ok.");
  if (!(await hit(db, "photo_report", reporter.id, 20, 3600))) throw new AppError("rate_limited", "Túl sok jelentés. Próbáld újra később.", 429);
  const p = await getPhoto(db, photoId);
  if (!(await canView(db, reporter, p))) throw new AppError("not_found", "A fotó nem található.", 404);
  const [ev] = await db.select().from(events).where(eq(events.id, p.eventId));
  await db.transaction(async (tx) => {
    await tx.insert(photoReports).values({ photoId, reporterType: reporter.type, reporterId: reporter.id, reason, text: text?.trim() || null }).onConflictDoNothing();
    await tx.update(photos).set({ status: "hidden_reported" }).where(eq(photos.id, photoId));
    await audit(tx, { actorType: reporter.type, actorId: reporter.id, action: "photo.report", entityType: "photo", entityId: photoId, eventId: p.eventId, after: { reason } });
    await notifyAdmins(tx, cfg, "Jelentett fotó", "Egy fotót jelentettek, és elrejtettük a résztvevők elől. Kérjük, bírálja el az adminisztrációs felületen.", `admin_photo_report:${photoId}`, p.eventId);
  });
  void ev;
}

/** Admin döntés: visszaállítás vagy végleges törlés (nincs "figyelmen kívül hagyás"). */
export async function decideReport(db: Db, cfg: Config, adminId: string, photoId: string, decision: "restore" | "delete") {
  const p = await getPhoto(db, photoId);
  if (p.status !== "hidden_reported") throw new AppError("bad_state", "Ehhez a fotóhoz nincs elbírálandó jelentés.", 409);
  if (decision === "delete") return adminDeletePhoto(db, cfg, adminId, photoId, "jelentés alapján");
  await db.transaction(async (tx) => {
    await tx.update(photos).set({ status: "visible" }).where(eq(photos.id, photoId));
    await tx.update(photoReports).set({ decision: "restored", decidedBy: adminId, decidedAt: new Date() }).where(and(eq(photoReports.photoId, photoId), sql`${photoReports.decision} is null`));
    await audit(tx, { actorType: "admin", actorId: adminId, action: "photo.restore", entityType: "photo", entityId: photoId, eventId: p.eventId });
  });
}

/** Admin: eseményszintű galéria teljes információval (csapatnév, jelentések). */
export async function adminGallery(db: Db, eventId: string, filter?: "reported") {
  const rows = await db.select({ p: photos, team: teams.name, number: stations.number }).from(photos)
    .innerJoin(teams, eq(teams.id, photos.teamId)).innerJoin(stations, eq(stations.id, photos.stationId))
    .where(and(eq(photos.eventId, eventId), filter === "reported" ? eq(photos.status, "hidden_reported") : inArray(photos.status, ["visible", "hidden_reported", "pending_review", "rejected"])))
    .orderBy(photos.receivedAt);
  const ids = rows.map((r) => r.p.id);
  const reports = ids.length ? await db.select().from(photoReports).where(inArray(photoReports.photoId, ids)) : [];
  const names = new Map<string, string>();
  for (const r of reports) {
    if (r.reporterType === "team") {
      const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, r.reporterId));
      names.set(r.id, t?.name ?? "?");
    } else {
      const [h] = await db.select({ n: stations.number }).from(hosts).innerJoin(stations, eq(stations.hostId, hosts.id)).where(eq(hosts.id, r.reporterId));
      names.set(r.id, h ? `Állomás #${h.n} (host)` : "host");
    }
  }
  return rows.map((r) => ({
    id: r.p.id, status: r.p.status, team: r.team, stationNumber: r.number, reviewReason: r.p.reviewReason, thumbUrl: `/api/photos/${r.p.id}/thumb`, url: `/api/photos/${r.p.id}/full`, receivedAt: r.p.receivedAt,
    reports: reports.filter((x) => x.photoId === r.p.id).map((x) => ({ reporter: names.get(x.id), reason: x.reason, text: x.text, at: x.at, decision: x.decision })),
  }));
}
