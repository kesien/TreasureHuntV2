import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checkIns, emailDeliveries, events, hosts, stations, teamMembers, teams } from "../src/db/schema.js";
import { accessLogin, createCredential } from "../src/services/accessAuth.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); });

const hour = 3600_000;
const LAT = 47.5, LON = 19.0;

async function world(nStations = 2, nTeams = 3) {
  const now = Date.now();
  const [ev] = await ctx.db.insert(events).values({
    name: "E", type: "halloween", status: "active", actualStart: new Date(now - hour), registrationStart: new Date(now - 100 * hour),
    registrationClose: new Date(now - 50 * hour), modificationDeadline: new Date(now - 40 * hour), plannedStart: new Date(now - hour), plannedEnd: new Date(now + 3 * hour),
  }).returning();
  const sts = [];
  const hostRows = [];
  for (let i = 1; i <= nStations; i++) {
    const [h] = await ctx.db.insert(hosts).values({
      eventId: ev!.id, contactName: "Host" + i, email: `h${i}@x.hu`, phone: "+36201112233", address: "A " + i, normalizedAddress: "a " + i,
      pickupMode: "ring_bell", status: "approved", latitude: LAT + i * 0.01, longitude: LON, locationConfirmed: true,
    }).returning();
    const [s] = await ctx.db.insert(stations).values({ eventId: ev!.id, number: i, hostId: h!.id, address: "A " + i, latitude: LAT + i * 0.01, longitude: LON, pickupMode: "ring_bell" }).returning();
    sts.push(s!); hostRows.push(h!);
  }
  await ctx.db.update(events).set({ nextStationNumber: nStations + 1 }).where(eq(events.id, ev!.id));
  const tms = [];
  for (let i = 1; i <= nTeams; i++) {
    const t = await ctx.db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values({ eventId: ev!.id, name: "Csapat" + i, contactName: "K", email: `t${i}@x.hu`, phone: "+36301234567", status: "approved", approvedAt: new Date(0) }).returning();
      await tx.insert(teamMembers).values([{ teamId: t!.id, name: "g", category: "child" }, { teamId: t!.id, name: "f", category: "adult" }]);
      return t!;
    });
    const { token } = await createCredential(ctx.db, "team", t.id, ev!.id, "481952");
    const l = await accessLogin(ctx.db, token, "481952", "9.9.9." + i);
    tms.push({ ...t, cookie: `th_access=${l.sessionToken}`, csrf: l.csrfToken });
  }
  return { ev: ev!, sts, tms, hostRows };
}
async function hostSession(h: { id: string }, evId: string) {
  const { token } = await createCredential(ctx.db, "host", h.id, evId, "481952");
  const l = await accessLogin(ctx.db, token, "481952", "8.8.8.8");
  return { cookie: `th_access=${l.sessionToken}`, "x-csrf-token": l.csrfToken };
}
const hd = (t: { cookie: string; csrf: string }) => ({ cookie: t.cookie, "x-csrf-token": t.csrf });
const ci = (t: { cookie: string; csrf: string }, stationId: string, lat = LAT, lon = LON, accuracy: number | null = 10) =>
  ctx.app.inject({ method: "POST", url: "/api/access/checkin", headers: hd(t), payload: { stationId, latitude: lat, longitude: lon, accuracy } });

describe("check-in", () => {
  it("sikeres belül, idempotens; távolság/pontosság tárolt, koordináta nem", async () => {
    const { sts, tms } = await world();
    const s1 = sts[0]!;
    const r = await ci(tms[0]!, s1.id, s1.latitude + 0.0005, s1.longitude); // ~55 m
    expect(r.json()).toMatchObject({ result: "ok", alreadyCheckedIn: false });
    expect((await ci(tms[0]!, s1.id, s1.latitude, s1.longitude)).json().alreadyCheckedIn).toBe(true);
    const rows = await ctx.db.select().from(checkIns);
    expect(rows.length).toBe(1);
    expect(rows[0]!.distanceM).toBeGreaterThan(40);
    expect(Object.keys(rows[0]!).some((k) => /latitude|longitude/i.test(k))).toBe(false);
  });

  it("túl messze, pontatlan GPS, ismeretlen állomás, nem aktív esemény", async () => {
    const { ev, sts, tms } = await world();
    const s1 = sts[0]!;
    expect((await ci(tms[0]!, s1.id, s1.latitude + 0.01, s1.longitude)).json()).toMatchObject({ result: "too_far", radiusM: 120 });
    expect((await ci(tms[0]!, s1.id, s1.latitude, s1.longitude, 500)).json().result).toBe("inaccurate");
    expect((await ctx.db.select().from(checkIns)).length).toBe(0);
    expect((await ci(tms[0]!, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    await ctx.db.update(events).set({ status: "closed" }).where(eq(events.id, ev.id));
    expect((await ci(tms[0]!, s1.id, s1.latitude, s1.longitude)).statusCode).toBe(409);
  });

  it("párhuzamos dupla kérés is egyetlen check-in", async () => {
    const { sts, tms } = await world();
    const [a, b] = await Promise.all([ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude), ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude)]);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect((await ctx.db.select().from(checkIns)).length).toBe(1);
  });

  it("eltávolított állomásra nem lehet becsekkolni", async () => {
    const { sts, tms } = await world();
    await ctx.db.update(stations).set({ status: "removed" }).where(eq(stations.id, sts[0]!.id));
    expect((await ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude)).json().error).toBe("station_removed");
  });
});

describe("játékidő és haladás", () => {
  it("az első check-intől indul, 1/2 → 2/2 kész; új állomás újra nyitottá teszi", async () => {
    const { ev, sts, tms } = await world();
    const prog = async () => (await ctx.app.inject({ method: "GET", url: "/api/access/progress", headers: { cookie: tms[0]!.cookie } })).json();
    expect(await prog()).toMatchObject({ completed: 0, required: 2, elapsedSec: 0, firstCheckInAt: null, finished: false });
    await ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude);
    expect(await prog()).toMatchObject({ completed: 1, required: 2, finished: false });
    await ci(tms[0]!, sts[1]!.id, sts[1]!.latitude, sts[1]!.longitude);
    const done = await prog();
    expect(done).toMatchObject({ completed: 2, required: 2, finished: true, frozen: true });

    // admin új virtuális állomást ad hozzá → újra nyitott
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const add = await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, payload: { address: "Új tér 1", lat: 47.6, lon: 19.1, pickupMode: "gift_outside", confirmed: true } });
    expect(add.statusCode).toBe(201);
    expect(await prog()).toMatchObject({ completed: 2, required: 3, finished: false, frozen: false });
    // az eltávolított állomás csökkenti az elvárt számot
    await ctx.app.inject({ method: "DELETE", url: `/api/admin/stations/${add.json().station.id}`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, payload: { reason: "teszt" } });
    expect(await prog()).toMatchObject({ completed: 2, required: 2, finished: true });
  });

  it("esemény végén a részleges állapot befagy", async () => {
    const { ev, sts, tms } = await world();
    await ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude);
    await ctx.db.update(events).set({ status: "closed", actualEnd: new Date(Date.now() + 60_000) }).where(eq(events.id, ev.id));
    const p = (await ctx.app.inject({ method: "GET", url: "/api/access/progress", headers: { cookie: tms[0]!.cookie } })).json();
    expect(p).toMatchObject({ completed: 1, finished: false, frozen: true });
  });

  it("admin manuális check-in: indok kötelező, auditált, duplán nem", async () => {
    const { sts, tms } = await world();
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const h = { cookie: s.cookie, "x-csrf-token": s.csrf };
    const body = { teamId: tms[0]!.id, stationId: sts[0]!.id, at: new Date().toISOString() };
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/checkins", headers: h, payload: { ...body, reason: " " } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/checkins", headers: h, payload: { ...body, reason: "Lemerült a telefon" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/checkins", headers: h, payload: { ...body, reason: "x" } })).statusCode).toBe(409);
    const [row] = await ctx.db.select().from(checkIns);
    expect(row).toMatchObject({ adminRecorded: true, source: "admin" });
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "checkin.manual"))).length).toBe(1);
  });
});

describe("ajándék ciklus", () => {
  async function visitAll(tms: Awaited<ReturnType<typeof world>>["tms"], st: { id: string; latitude: number; longitude: number }) {
    for (const t of tms) await ci(t, st.id, st.latitude, st.longitude);
  }
  const out = (t: { cookie: string; csrf: string }, id: string) => ctx.app.inject({ method: "POST", url: `/api/access/stations/${id}/out-of-gifts`, headers: hd(t) });

  it("jelzés csak check-in után, csapatonként egyszer; 3 különböző csapat → figyelmeztetés egyszer", async () => {
    const { ev, sts, tms } = await world(1, 4);
    const st = sts[0]!;
    expect((await out(tms[0]!, st.id)).json().error).toBe("checkin_required");
    await visitAll(tms.slice(0, 3), st);
    await out(tms[0]!, st.id);
    expect((await out(tms[0]!, st.id)).json().alreadyReported).toBe(true);
    await out(tms[1]!, st.id);
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "station_warning"))).length).toBe(0);
    const third = await out(tms[2]!, st.id);
    expect(third.json().likelyOut).toBe(true);
    const warn = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "station_warning"));
    expect(warn.map((m) => m.recipient).sort()).toEqual(["h1@x.hu", "t4@x.hu"]); // host + a még nem járt csapat
    // a negyedik jelzés nem küld újra
    await visitAll([tms[3]!], st);
    await out(tms[3]!, st.id);
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "station_warning"))).length).toBe(2);
    void ev;
  });

  it("host látja az összesített figyelmeztetést, a jelentőket nem; újratöltés új ciklust indít", async () => {
    const { ev, sts, tms, hostRows } = await world(1, 3);
    const st = sts[0]!;
    await visitAll(tms, st);
    for (const t of tms) await out(t, st.id);
    const h = await hostSession(hostRows[0]!, ev.id);
    const dash = (await ctx.app.inject({ method: "GET", url: "/api/access/host/dashboard", headers: { cookie: h.cookie } })).json();
    expect(dash.gift).toMatchObject({ reportCount: 3, likelyOut: true, status: "has_gifts" });
    expect(dash.visits.length).toBe(3);
    expect(dash.visits[0]).toMatchObject({ total: 2, children: 1, adults: 1 });
    expect(JSON.stringify(dash)).not.toMatch(/Kovács|"g"|"f"/);

    const re = await ctx.app.inject({ method: "POST", url: "/api/access/host/gift/restock", headers: h, payload: { stationId: st.id } });
    expect(re.json()).toMatchObject({ status: "has_gifts", reports: 0, likelyOut: false });
    // új ciklus: az első jelzések nem számítanak bele; korábbi csapat újra jelezhet
    await out(tms[0]!, st.id);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/host/dashboard", headers: { cookie: h.cookie } })).json().gift.reportCount).toBe(1);
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const hist = (await ctx.app.inject({ method: "GET", url: `/api/admin/stations/${st.id}/gifts`, headers: { cookie: s.cookie } })).json();
    expect(hist.history.length).toBe(2);
    expect(hist.history[0].reports.map((r: { team: string }) => r.team).sort()).toEqual(["Csapat1", "Csapat2", "Csapat3"]);
  });

  it("host elfogyottra állít megjegyzéssel; a csapat látja; más host nem nyúlhat hozzá; admin indokkal", async () => {
    const { ev, sts, tms, hostRows } = await world(2, 1);
    const h1 = await hostSession(hostRows[0]!, ev.id);
    const r = await ctx.app.inject({ method: "POST", url: "/api/access/host/gift/depleted", headers: h1, payload: { stationId: sts[0]!.id, note: "Holnap újra lesz" } });
    expect(r.json()).toMatchObject({ status: "depleted", note: "Holnap újra lesz" });
    const other = await ctx.app.inject({ method: "POST", url: "/api/access/host/gift/depleted", headers: h1, payload: { stationId: sts[1]!.id } });
    expect(other.statusCode).toBe(403);
    const list = (await ctx.app.inject({ method: "GET", url: "/api/access/stations", headers: { cookie: tms[0]!.cookie } })).json();
    expect(list.stations[0]).toMatchObject({ giftStatus: "depleted", giftNote: "Holnap újra lesz", completed: false });
    expect(list.stations[1]).toMatchObject({ giftStatus: "has_gifts" });

    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const ah = { cookie: s.cookie, "x-csrf-token": s.csrf };
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/stations/${sts[1]!.id}/gifts`, headers: ah, payload: { action: "depleted", reason: "" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/stations/${sts[1]!.id}/gifts`, headers: ah, payload: { action: "depleted", reason: "Virtuális állomás kifogyott" } })).statusCode).toBe(200);
  });

  it("elfogyott állomáson a check-in továbbra is lehetséges", async () => {
    const { ev, sts, tms, hostRows } = await world(1, 1);
    const h = await hostSession(hostRows[0]!, ev.id);
    await ctx.app.inject({ method: "POST", url: "/api/access/host/gift/depleted", headers: h, payload: { stationId: sts[0]!.id } });
    expect((await ci(tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude)).json().result).toBe("ok");
  });
});
