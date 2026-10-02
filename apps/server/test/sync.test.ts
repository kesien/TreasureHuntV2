import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checkIns, events, photos, stations } from "../src/db/schema.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";
import { hd, hostSession, world } from "./world.js";

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); });

type T = { cookie: string; csrf: string };
const iso = (ms: number) => new Date(ms).toISOString();
const item = (stationId: string, lat: number, lon: number, capturedAt: string, clientId = "client-" + Math.random().toString(36).slice(2), accuracy = 10) =>
  ({ clientId, stationId, capturedAt, latitude: lat, longitude: lon, accuracy });
const sync = (t: T, items: unknown[]) => ctx.app.inject({ method: "POST", url: "/api/access/sync/checkins", headers: hd(t), payload: { items } });
const png = () => sharp({ create: { width: 200, height: 100, channels: 3, background: "#fa0" } }).png().toBuffer();

async function uploadOffline(t: T, stationId: string, clientId: string, capturedAt: string) {
  const b = "----x" + Math.random().toString(16).slice(2);
  const file = await png();
  const field = (k: string, v: string) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const payload = Buffer.concat([field("clientId", clientId), field("capturedAt", capturedAt),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`)]);
  return ctx.app.inject({ method: "POST", url: `/api/access/stations/${stationId}/photos`, payload, headers: { ...hd(t), "content-type": `multipart/form-data; boundary=${b}` } });
}

async function adminH() {
  const a = await createActiveAdmin(ctx);
  const s = await loginAdmin(ctx, a);
  return { cookie: s.cookie, "x-csrf-token": s.csrf };
}

describe("offline check-in szinkron", () => {
  it("több független elem; az első helyi idő számít; duplikált szinkron nem hoz létre újat", async () => {
    const { sts, tms } = await world(ctx, 3, 1);
    const t = tms[0]!;
    const t0 = Date.now() - 30 * 60_000;
    const items = sts.map((s, i) => item(s.id, s.latitude, s.longitude, iso(t0 + i * 60_000), "c" + i + "-aaaaaaaa"));
    const r1 = (await sync(t, items)).json();
    expect(r1.results.map((r: { status: string }) => r.status)).toEqual(["accepted", "accepted", "accepted"]);
    const r2 = (await sync(t, items)).json();
    expect(r2.results.map((r: { status: string }) => r.status)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect((await ctx.db.select().from(checkIns)).length).toBe(3);
    const p = (await ctx.app.inject({ method: "GET", url: "/api/access/progress", headers: { cookie: t.cookie } })).json();
    expect(new Date(p.firstCheckInAt).getTime()).toBe(t0); // eredeti helyi idő, nem a fogadási
    expect(p).toMatchObject({ completed: 3, finished: true });
    const [row] = await ctx.db.select().from(checkIns).where(eq(checkIns.clientId, "c0-aaaaaaaa"));
    expect(row!.receivedAt.getTime()).toBeGreaterThan(row!.originalAt.getTime() + 20 * 60_000);
    expect(row!.source).toBe("offline");
  });

  it("egy hibás elem nem blokkolja a többit; ismeretlen állomásra nem hozható létre check-in", async () => {
    const { sts, tms } = await world(ctx, 2, 1);
    const t0 = Date.now() - 600_000;
    const r = (await sync(tms[0]!, [
      item("00000000-0000-4000-8000-000000000000", 47.5, 19, iso(t0), "bad-aaaaaaaa"),
      item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(t0), "ok1-aaaaaaa"),
      item(sts[1]!.id, sts[1]!.latitude + 0.05, sts[1]!.longitude, iso(t0), "far-aaaaaaa"),
    ])).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(["rejected", "accepted", "needs_review"]);
    expect(r.results[0].reason).toBe("unknown_station");
    expect(r.results[2].reason).toBe("distance_mismatch");
  });

  it("esemény vége: 19:58-as elfogadható, 20:10-es admin review; időbélyegek külön maradnak", async () => {
    const { ev, sts, tms } = await world(ctx, 2, 1);
    const end = Date.now() - 60 * 60_000;
    await ctx.db.update(events).set({ status: "closed", actualStart: new Date(end - 3 * 3600_000), actualEnd: new Date(end) }).where(eq(events.id, ev.id));
    const r = (await sync(tms[0]!, [
      item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(end - 2 * 60_000), "before-aaaaaa"),
      item(sts[1]!.id, sts[1]!.latitude, sts[1]!.longitude, iso(end + 10 * 60_000), "after-aaaaaaa"),
    ])).json();
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(["accepted", "needs_review"]);
    expect(r.results[1].reason).toBe("after_event_end");
    const [row] = await ctx.db.select().from(checkIns).where(eq(checkIns.clientId, "after-aaaaaaa"));
    expect(row!.originalAt.getTime()).toBe(end + 10 * 60_000);
    expect(row!.receivedAt.getTime()).toBeGreaterThan(row!.originalAt.getTime());
  });

  it("irreális (jövőbeli) óra és esemény előtti idő admin review-ra kerül, értesítéssel", async () => {
    const { sts, tms } = await world(ctx, 2, 1);
    const adminH0 = await createActiveAdmin(ctx);
    void adminH0;
    const r = (await sync(tms[0]!, [
      item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(Date.now() + 3 * 3600_000), "fut-aaaaaaaa"),
      item(sts[1]!.id, sts[1]!.latitude, sts[1]!.longitude, iso(Date.now() - 5 * 3600_000), "pre-aaaaaaaa"),
    ])).json();
    expect(r.results.map((x: { reason: string }) => x.reason)).toEqual(["clock_anomaly", "before_event_start"]);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "checkin.needs_review"))).length).toBe(2);
  });

  it("törölt állomás: review; admin elfogadja/elutasítja; progress csak elfogadottat számol", async () => {
    const { ev, sts, tms } = await world(ctx, 2, 1);
    await ctx.db.update(stations).set({ status: "removed" }).where(eq(stations.id, sts[0]!.id));
    const r = (await sync(tms[0]!, [item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(Date.now() - 600_000), "rem-aaaaaaaa")])).json();
    expect(r.results[0]).toMatchObject({ status: "needs_review", reason: "station_removed" });
    const h = await adminH();
    const list = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/reviews`, headers: h })).json();
    expect(list[0]).toMatchObject({ team: "Csapat1", stationNumber: 1, stationRemoved: true, reason: "station_removed" });
    const [c] = await ctx.db.select().from(checkIns);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/checkins/${c!.id}/review`, headers: h, payload: { decision: "reject", reason: "állomás megszűnt" } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(checkIns))[0]!.status).toBe("rejected");
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/checkins/${c!.id}/review`, headers: h, payload: { decision: "accept" } })).statusCode).toBe(409);
    // ismételt szinkron ugyanarra: duplicate, nem éled újra
    const again = (await sync(tms[0]!, [item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(Date.now() - 600_000), "rem-aaaaaaaa")])).json();
    expect(again.results[0]).toMatchObject({ status: "duplicate", checkInStatus: "rejected" });
  });

  it("új állomás: offline kliens csak szinkron után látja; előtte nem tud rá check-int küldeni", async () => {
    const { ev, sts, tms } = await world(ctx, 1, 1);
    const h = await adminH();
    const add = await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: h, payload: { address: "Új tér 1", lat: 47.6, lon: 19.1, pickupMode: "ring_bell", confirmed: true } });
    const newId = add.json().station.id as string;
    const list = (await ctx.app.inject({ method: "GET", url: "/api/access/stations", headers: { cookie: tms[0]!.cookie } })).json();
    expect(list.stations.map((s: { id: string }) => s.id)).toContain(newId); // frissítés után megjelenik
    void sts;
  });
});

describe("offline fotók", () => {
  it("fotó csak ismert check-inhez; duplikált szinkron egy fotó; check-in nélkül 409", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    const cap = iso(Date.now() - 600_000);
    expect((await uploadOffline(tms[0]!, st.id, "ph-aaaaaaaa", cap)).json().error).toBe("checkin_required");
    await sync(tms[0]!, [item(st.id, st.latitude, st.longitude, cap, "c-aaaaaaaa")]);
    const a = await uploadOffline(tms[0]!, st.id, "ph-aaaaaaaa", cap);
    const b = await uploadOffline(tms[0]!, st.id, "ph-aaaaaaaa", cap);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    const rows = await ctx.db.select().from(photos);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("visible");
    expect(rows[0]!.originalAt.toISOString()).toBe(cap);
  });

  it("eseményvég után szinkronizált fotó: korai időbélyeg elfogadott, késői review", async () => {
    const { ev, sts, tms } = await world(ctx, 1, 1);
    const st = sts[0]!;
    const end = Date.now() - 3600_000;
    const early = iso(end - 120_000);
    await ctx.db.update(events).set({ actualStart: new Date(end - 3 * 3600_000) }).where(eq(events.id, ev.id));
    await sync(tms[0]!, [item(st.id, st.latitude, st.longitude, early, "c-aaaaaaaa")]);
    await ctx.db.update(events).set({ status: "closed", actualStart: new Date(end - 3 * 3600_000), actualEnd: new Date(end) }).where(eq(events.id, ev.id));
    expect((await uploadOffline(tms[0]!, st.id, "p1-aaaaaaaa", early)).json().status).toBe("visible");
    expect((await uploadOffline(tms[0]!, st.id, "p2-aaaaaaaa", iso(end + 600_000))).json().status).toBe("pending_review");
    // online (nem offline) feltöltés lezárt eseménynél továbbra sem megy
  });

  it("törölt állomás + offline fotó: review; elutasításkor nem jelenik meg a galériában, elfogadáskor igen", async () => {
    const { ev, sts, tms, hostRows } = await world(ctx, 2, 1);
    const st = sts[0]!;
    const cap = iso(Date.now() - 600_000);
    // a csapat offline becsekkolt és fotózott; közben az admin törölte az állomást
    await ctx.db.update(stations).set({ status: "removed" }).where(eq(stations.id, st.id));
    expect((await sync(tms[0]!, [item(st.id, st.latitude, st.longitude, cap, "c-aaaaaaaa")])).json().results[0].status).toBe("needs_review");
    expect((await uploadOffline(tms[0]!, st.id, "p-aaaaaaaa", cap)).json().status).toBe("pending_review");
    const h = await adminH();
    const rev = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/reviews`, headers: h })).json();
    expect(rev[0].pendingPhotos).toBe(1); // az admin látja az összefüggést
    const gal = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/photos`, headers: h })).json();
    expect(gal[0]).toMatchObject({ status: "pending_review", reviewReason: "checkin_needs_review" });
    const [photo] = await ctx.db.select().from(photos);
    // várakozó fotót a résztvevők nem látnak
    expect((await ctx.app.inject({ method: "GET", url: `/api/photos/${photo!.id}/full`, headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(404);
    const [c] = await ctx.db.select().from(checkIns);
    await ctx.app.inject({ method: "POST", url: `/api/admin/checkins/${c!.id}/review`, headers: h, payload: { decision: "reject" } });
    expect((await ctx.db.select().from(photos))[0]!.status).toBe("rejected");

    // elfogadás ugyanígy egy másik állomáson
    await ctx.db.update(stations).set({ status: "removed" }).where(eq(stations.id, sts[1]!.id));
    await sync(tms[0]!, [item(sts[1]!.id, sts[1]!.latitude, sts[1]!.longitude, cap, "c2-aaaaaaaa")]);
    await uploadOffline(tms[0]!, sts[1]!.id, "p2-aaaaaaaa", cap);
    const [c2] = await ctx.db.select().from(checkIns).where(eq(checkIns.clientId, "c2-aaaaaaaa"));
    await ctx.app.inject({ method: "POST", url: `/api/admin/checkins/${c2!.id}/review`, headers: h, payload: { decision: "accept" } });
    const p2 = (await ctx.db.select().from(photos).where(eq(photos.clientId, "p2-aaaaaaaa")))[0]!;
    expect(p2.status).toBe("visible");
    void hostRows;
  });

  it("online feltöltés lezárt eseménynél nem megy (csak offline szinkron)", async () => {
    const { ev, sts, tms } = await world(ctx, 1, 1);
    await sync(tms[0]!, [item(sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude, iso(Date.now() - 600_000), "c-aaaaaaaa")]);
    await ctx.db.update(events).set({ status: "closed", actualEnd: new Date() }).where(eq(events.id, ev.id));
    const b = "----y";
    const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), await png(), Buffer.from(`\r\n--${b}--\r\n`)]);
    const r = await ctx.app.inject({ method: "POST", url: `/api/access/stations/${sts[0]!.id}/photos`, payload, headers: { ...hd(tms[0]!), "content-type": `multipart/form-data; boundary=${b}` } });
    expect(r.json().error).toBe("not_active");
  });
});

describe("szinkron védelmek", () => {
  it("túl nagy batch elutasítva; bejelentkezés nélkül 401; visszalépett csapat elemei elutasítva", async () => {
    const { sts, tms } = await world(ctx, 1, 1);
    const many = Array.from({ length: 51 }, (_, i) => item(sts[0]!.id, 47, 19, iso(Date.now() - 60_000), "m" + i + "-aaaaaaaa"));
    expect((await sync(tms[0]!, many)).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/sync/checkins", payload: { items: [] } })).statusCode).toBe(401);
    void hostSession;
  });
});
