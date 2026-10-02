import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, emailDeliveries, photoReports, photos } from "../src/db/schema.js";
import { photoPath } from "../src/services/photos.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";
import { ci, hd, hostSession, world } from "./world.js";

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); });

function multipartBody(file: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) {
  const b = "----th" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

const jpegWithExif = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#3a7" } }).jpeg().withExif({ IFD0: { Copyright: "SECRET-OWNER" } }).toBuffer();
const png = () => sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();

async function upload(t: { cookie: string; csrf: string }, stationId: string, file: Buffer, name = "a.jpg", type = "image/jpeg", fields: Record<string, string> = {}) {
  const m = multipartBody(file, name, type, fields);
  return ctx.app.inject({ method: "POST", url: `/api/access/stations/${stationId}/photos`, payload: m.payload, headers: { ...hd(t), "content-type": m.contentType } });
}

describe("fotó feltöltés", () => {
  it("check-in előtt tiltott; utána feldolgozva: JPEG, max 2560 px, EXIF nélkül, thumbnail", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    expect((await upload(tms[0]!, st.id, await jpegWithExif())).json().error).toBe("checkin_required");
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const r = await upload(tms[0]!, st.id, await jpegWithExif());
    expect(r.statusCode).toBe(201);
    const [p] = await ctx.db.select().from(photos);
    const out = sharp(photoPath(ctx.cfg, p!.fileKey!));
    const meta = await out.metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(2560);
    expect(meta.exif).toBeUndefined();
    expect((await sharp(photoPath(ctx.cfg, p!.thumbKey!)).metadata()).width).toBeLessThanOrEqual(400);
  });

  it("PNG/átlátszó kép is feldolgozható; hamis kiterjesztés és rosszul formázott fájl elutasítva", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    expect((await upload(tms[0]!, st.id, await png(), "a.png", "image/png")).statusCode).toBe(201);
    expect((await upload(tms[0]!, st.id, Buffer.from("<?php echo 1; ?>"), "evil.jpg", "image/jpeg")).json().error).toBe("invalid_image");
    expect((await upload(tms[0]!, st.id, (await jpegWithExif()).subarray(0, 4000), "cut.jpg")).json().error).toBe("invalid_image");
    expect((await ctx.db.select().from(photos)).length).toBe(1);
  });

  it("dekompressziós bomba (extrém pixelméret) elutasítva", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(5_000_000);
    expect((await upload(tms[0]!, st.id, bomb, "b.png", "image/png")).json().error).toBe("invalid_image");
  });

  it("20 MB feletti fájl elutasítva", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const r = await upload(tms[0]!, st.id, Buffer.alloc(21 * 1024 * 1024, 1));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect((await ctx.db.select().from(photos)).length).toBe(0);
  });

  it("legfeljebb 5 fotó / csapat / állomás, párhuzamosan is; törlés felszabadít", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const img = await png();
    const rs = await Promise.all(Array.from({ length: 7 }, () => upload(tms[0]!, st.id, img, "a.png", "image/png")));
    expect(rs.filter((r) => r.statusCode === 201).length).toBe(5);
    expect(rs.filter((r) => r.json().error === "photo_limit").length).toBe(2);
    const [p] = await ctx.db.select().from(photos);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/access/photos/${p!.id}`, headers: hd(tms[0]!) })).statusCode).toBe(200);
    expect(existsSync(photoPath(ctx.cfg, p!.fileKey!))).toBe(false);
    expect((await upload(tms[0]!, st.id, img, "a.png", "image/png")).statusCode).toBe(201);
  });

  it("clientId alapú idempotencia", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const img = await png();
    const a = await upload(tms[0]!, st.id, img, "a.png", "image/png", { clientId: "c-1" });
    const b = await upload(tms[0]!, st.id, img, "a.png", "image/png", { clientId: "c-1" });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect((await ctx.db.select().from(photos)).length).toBe(1);
  });

  it("esemény lezárása után nincs új fotó", async () => {
    const { ev, sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    await ci(ctx, tms[0]!, st.id, st.latitude, st.longitude);
    const { events } = await import("../src/db/schema.js");
    await ctx.db.update(events).set({ status: "closed" }).where(eq(events.id, ev.id));
    expect((await upload(tms[0]!, st.id, await png(), "a.png", "image/png")).json().error).toBe("not_active");
  });
});

describe("láthatóság és anonimitás", () => {
  it("becsekkolt csapat és a host látja; más csapat és más host nem; csapatnév sehol", async () => {
    const { ev, sts, tms, hostRows } = await world(ctx, 2, 3);
    const s1 = sts[0]!;
    await ci(ctx, tms[0]!, s1.id, s1.latitude, s1.longitude);
    await ci(ctx, tms[1]!, s1.id, s1.latitude, s1.longitude);
    const up = await upload(tms[0]!, s1.id, await png(), "a.png", "image/png");
    const pid = up.json().id as string;

    const list = await ctx.app.inject({ method: "GET", url: `/api/access/stations/${s1.id}/photos`, headers: { cookie: tms[1]!.cookie } });
    expect(list.json().length).toBe(1);
    expect(list.json()[0].mine).toBe(false);
    expect(JSON.stringify(list.json())).not.toContain("Csapat1");
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/thumb`, headers: { cookie: tms[1]!.cookie } })).statusCode).toBe(200);
    // nem becsekkolt csapat
    expect((await ctx.app.inject({ method: "GET", url: `/api/access/stations/${s1.id}/photos`, headers: { cookie: tms[2]!.cookie } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: tms[2]!.cookie } })).statusCode).toBe(404);
    // host
    const h1 = await hostSession(ctx, hostRows[0]!, ev.id);
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: h1.cookie } })).statusCode).toBe(200);
    const h2 = await hostSession(ctx, hostRows[1]!, ev.id);
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: h2.cookie } })).statusCode).toBe(404);
    // bejelentkezés nélkül
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full` })).statusCode).toBe(401);
  });
});

describe("jelentés és moderáció", () => {
  async function reported() {
    const a = await createActiveAdmin(ctx); // az értesítés a jelentés pillanatában létező adminoknak megy
    const s = await loginAdmin(ctx, a);
    const w = await world(ctx, 1, 2);
    const st = w.sts[0]!;
    for (const t of w.tms) await ci(ctx, t, st.id, st.latitude, st.longitude);
    const pid = (await upload(w.tms[0]!, st.id, await png(), "a.png", "image/png")).json().id as string;
    const rep = await ctx.app.inject({ method: "POST", url: `/api/access/photos/${pid}/report`, headers: hd(w.tms[1]!), payload: { reason: "child_privacy", text: "gyerek arca" } });
    expect(rep.statusCode).toBe(200);
    return { ...w, st, pid, ah: { cookie: s.cookie, "x-csrf-token": s.csrf } };
  }

  it("jelentés után azonnal rejtett a résztvevőknek; admin látja a jelentőt; értesítés + audit", async () => {
    const { st, pid, tms, ah } = await reported();
    expect((await ctx.app.inject({ method: "GET", url: `/api/access/stations/${st.id}/photos`, headers: { cookie: tms[1]!.cookie } })).json().length).toBe(0);
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: ah.cookie } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "admin_notice"))).length).toBeGreaterThan(0);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "photo.report"))).length).toBe(1);
    const ev = tms[0]!.eventId;
    const gal = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev}/photos?filter=reported`, headers: { cookie: ah.cookie } })).json();
    expect(gal[0].reports[0]).toMatchObject({ reporter: "Csapat2", reason: "child_privacy" });
  });

  it("visszaállítás: újra látható, a jelentés története megmarad", async () => {
    const { st, pid, tms, ah } = await reported();
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/photos/${pid}/decision`, headers: ah, payload: { decision: "restore" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/api/access/stations/${st.id}/photos`, headers: { cookie: tms[1]!.cookie } })).json().length).toBe(1);
    const [r] = await ctx.db.select().from(photoReports);
    expect(r!.decision).toBe("restored");
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/photos/${pid}/decision`, headers: ah, payload: { decision: "restore" } })).statusCode).toBe(409);
  });

  it("végleges törlés: fájl törölve, jelentés + döntés megmarad", async () => {
    const { pid, ah } = await reported();
    const [before] = await ctx.db.select().from(photos);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/photos/${pid}/decision`, headers: ah, payload: { decision: "delete" } })).statusCode).toBe(200);
    const [p] = await ctx.db.select().from(photos);
    expect(p!.status).toBe("deleted");
    expect(existsSync(photoPath(ctx.cfg, before!.fileKey!))).toBe(false);
    expect((await ctx.db.select().from(photoReports))[0]!.decision).toBe("deleted");
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${pid}/full`, headers: { cookie: ah.cookie } })).statusCode).toBe(404);
  });

  it("hibás jelentési ok elutasítva; nem látható fotó nem jelenthető", async () => {
    const w = await world(ctx, 1, 2);
    const st = w.sts[0]!;
    await ci(ctx, w.tms[0]!, st.id, st.latitude, st.longitude);
    const pid = (await upload(w.tms[0]!, st.id, await png(), "a.png", "image/png")).json().id as string;
    expect((await ctx.app.inject({ method: "POST", url: `/api/access/photos/${pid}/report`, headers: hd(w.tms[1]!), payload: { reason: "spam" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: `/api/access/photos/${pid}/report`, headers: hd(w.tms[1]!), payload: { reason: "other" } })).statusCode).toBe(404); // nem becsekkolt
  });

  it("admin bármely fotót törölhet, auditálva", async () => {
    const w = await world(ctx, 1, 1);
    const st = w.sts[0]!;
    await ci(ctx, w.tms[0]!, st.id, st.latitude, st.longitude);
    const pid = (await upload(w.tms[0]!, st.id, await png(), "a.png", "image/png")).json().id as string;
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/admin/photos/${pid}`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, payload: { reason: "teszt" } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "photo.delete"))).length).toBe(1);
  });
});
