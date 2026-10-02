import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailDeliveries, events, hosts, stations, teams, teamMembers } from "../src/db/schema.js";
import type { GeocoderProvider } from "../src/services/geocode.js";
import { updateHost } from "../src/services/applications.js";
import { accessLogin, createCredential } from "../src/services/accessAuth.js";
import { runScheduled } from "../src/services/scheduler.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";

let calls = 0;
const fake: GeocoderProvider = {
  name: "fake",
  async search(a) { calls++; return a.includes("Nincs") ? null : { lat: 47.5, lon: 19.0, label: a, provider: "fake" }; },
};
const broken: GeocoderProvider = { name: "broken", async search() { throw new Error("down"); } };

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([broken, fake]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); calls = 0; });

const hour = 3600_000;
async function mkEvent(over: Partial<typeof events.$inferInsert> = {}) {
  const now = Date.now();
  const [ev] = await ctx.db.insert(events).values({
    name: "E", type: "halloween", status: "preparation", registrationStart: new Date(now - 100 * hour), registrationClose: new Date(now - 50 * hour),
    modificationDeadline: new Date(now - 40 * hour), plannedStart: new Date(now + 72 * hour), plannedEnd: new Date(now + 76 * hour), ...over,
  }).returning();
  return ev!;
}
async function admin() {
  const a = await createActiveAdmin(ctx);
  const s = await loginAdmin(ctx, a);
  return { cookie: s.cookie, "x-csrf-token": s.csrf };
}
async function mkHost(eventId: string, address: string, lat?: number, lon?: number, status = "pending") {
  const [h] = await ctx.db.insert(hosts).values({
    eventId, contactName: "Titkos Host", email: `${Math.random().toString(36).slice(2)}@x.hu`, phone: "+36201112233", address,
    normalizedAddress: address.toLowerCase(), pickupMode: "ring_bell", status, latitude: lat ?? null, longitude: lon ?? null, locationConfirmed: lat != null,
  }).returning();
  return h!;
}
async function mkTeam(eventId: string, name = "T") {
  return ctx.db.transaction(async (tx) => {
    const [t] = await tx.insert(teams).values({ eventId, name, contactName: "K", email: `${name.toLowerCase()}@x.hu`, phone: "+36301234567", status: "approved", approvedAt: new Date(0) }).returning();
    await tx.insert(teamMembers).values([{ teamId: t!.id, name: "g", category: "child" }, { teamId: t!.id, name: "f", category: "adult" }]);
    return t!;
  });
}

describe("geokódolás", () => {
  it("fallback, cache, nem található", async () => {
    const h = await admin();
    const go = (address: string) => ctx.app.inject({ method: "POST", url: "/api/geocode", headers: h, payload: { address } });
    expect((await go("Fő utca 1., Teszt")).json()).toMatchObject({ found: true, lat: 47.5 });
    await go("fő u. 1 teszt"); // ugyanaz normalizálva → cache
    expect(calls).toBe(1);
    expect((await go("Nincs ilyen utca 99")).json()).toEqual({ found: false });
  });
  it("bejelentkezés nélkül 401", async () => {
    expect((await ctx.app.inject({ method: "POST", url: "/api/geocode", payload: { address: "Fő utca 1." } })).statusCode).toBe(401);
  });
});

describe("állomások", () => {
  it("host jóváhagyás pozíció nélkül nem megy; utána állomás jön létre; számozás nem használ újra", async () => {
    const ev = await mkEvent();
    const h = await admin();
    const host1 = await mkHost(ev.id, "A u. 1");
    const fail = await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host1.id}/approve`, headers: h });
    expect(fail.json().error).toBe("location_not_confirmed");
    expect((await ctx.app.inject({ method: "PUT", url: `/api/admin/hosts/${host1.id}/location`, headers: h, payload: { lat: 47.5, lon: 19.0 } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host1.id}/approve`, headers: h })).statusCode).toBe(200);
    const host2 = await mkHost(ev.id, "B u. 2", 47.51, 19.01);
    await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host2.id}/approve`, headers: h });
    let list = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/stations`, headers: h })).json();
    expect(list.stations.map((s: { number: number }) => s.number)).toEqual([1, 2]);
    const first = list.stations[0].id;
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/admin/stations/${first}`, headers: h, payload: { reason: "" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/admin/stations/${first}`, headers: h, payload: { reason: "Lakó lemondta" } })).statusCode).toBe(200);
    const v = await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: h, payload: { address: "Tér 3.", lat: 47.52, lon: 19.02, pickupMode: "gift_outside", confirmed: true } });
    expect(v.json().station.number).toBe(3); // nem #1
    expect(v.json().station.hostId).toBeNull();
    list = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/stations`, headers: h })).json();
    expect(list.required).toBe(2);
  });

  it("közeli állomásra figyelmeztet, de a döntés az adminé", async () => {
    const ev = await mkEvent();
    const h = await admin();
    const body = (lat: number) => ({ address: "X utca 1", lat, lon: 19.0, pickupMode: "ring_bell", confirmed: true });
    await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: h, payload: body(47.5) });
    const r = await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: h, payload: body(47.50005) });
    expect(r.statusCode).toBe(201);
    expect(r.json().duplicateWarnings.length).toBe(1);
  });

  it("megerősítetlen markerrel nem hozható létre virtuális állomás", async () => {
    const ev = await mkEvent();
    const h = await admin();
    const r = await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev.id}/stations`, headers: h, payload: { address: "X utca 1", lat: 47.5, lon: 19.0, pickupMode: "ring_bell", confirmed: false } });
    expect(r.json().error).toBe("location_not_confirmed");
  });

  it("T−24 előtt csak darabszám, utána részletek; host neve sosem; eltávolítás azonnal eltűnik", async () => {
    const ev = await mkEvent({ plannedStart: new Date(Date.now() + 30 * hour), plannedEnd: new Date(Date.now() + 34 * hour) });
    const h = await admin();
    const host = await mkHost(ev.id, "Titkos u. 5.", 47.5, 19.0);
    await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host.id}/approve`, headers: h });
    const team = await mkTeam(ev.id);
    const { token } = await createCredential(ctx.db, "team", team.id, ev.id, "481952");
    const login = await accessLogin(ctx.db, token, "481952", "1.1.1.1");
    const cookie = `th_access=${login.sessionToken}`;
    const get = async () => (await ctx.app.inject({ method: "GET", url: "/api/access/stations", headers: { cookie } })).json();

    expect(await get()).toEqual({ revealed: false, count: 1 });
    await ctx.db.update(events).set({ plannedStart: new Date(Date.now() + 23 * hour), plannedEnd: new Date(Date.now() + 27 * hour) });
    const after = await get();
    expect(after.revealed).toBe(true);
    expect(after.stations[0]).toMatchObject({ number: 1, label: "Állomás #1", address: "Titkos u. 5." });
    expect(JSON.stringify(after)).not.toContain("Titkos Host");

    const [st] = await ctx.db.select().from(stations);
    await ctx.app.inject({ method: "DELETE", url: `/api/admin/stations/${st!.id}`, headers: h, payload: { reason: "teszt" } });
    expect((await get()).count).toBe(0);
    const mails = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "station_removal"));
    expect(mails.length).toBe(2); // csapat + host
  });

  it("címváltozás kiveszi az állomást; újra jóváhagyáskor ugyanaz a szám marad", async () => {
    const ev = await mkEvent({ modificationDeadline: new Date(Date.now() + hour) });
    const h = await admin();
    const host = await mkHost(ev.id, "C u. 1", 47.5, 19.0);
    await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host.id}/approve`, headers: h });
    const r = await updateHost(ctx.db, ctx.cfg, host.id, { address: "D u. 9" });
    expect(r.reapprovalRequired).toBe(true);
    expect((await ctx.db.select().from(stations))[0]!.status).toBe("removed");
    await ctx.app.inject({ method: "PUT", url: `/api/admin/hosts/${host.id}/location`, headers: h, payload: { lat: 47.6, lon: 19.1 } });
    await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${host.id}/approve`, headers: h });
    const all = await ctx.db.select().from(stations);
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ number: 1, status: "active", address: "D u. 9", latitude: 47.6 });
  });
});

describe("ütemezett feladatok", () => {
  it("jelentkezés lezárása; T−24 egyszer, csak a korábban jóváhagyottnak; végleges létszám a hostnak", async () => {
    const ev = await mkEvent({
      status: "registration_open", registrationClose: new Date(Date.now() - hour), plannedStart: new Date(Date.now() + 20 * hour),
      plannedEnd: new Date(Date.now() + 24 * hour), modificationDeadline: new Date(Date.now() - 30 * 60_000),
    });
    await mkTeam(ev.id, "Korai");
    const lateTeam = await mkTeam(ev.id, "Kesei");
    await ctx.db.update(teams).set({ approvedAt: new Date() }).where(eq(teams.id, lateTeam.id)); // T−24 után jóváhagyott
    const host = await mkHost(ev.id, "H u. 1", 47.5, 19.0, "approved");
    await ctx.db.update(hosts).set({ approvedAt: new Date(0) }).where(eq(hosts.id, host.id));
    await runScheduled(ctx.db, ctx.cfg);
    await runScheduled(ctx.db, ctx.cfg); // másodszor semmi új
    expect((await ctx.db.select().from(events))[0]!.status).toBe("preparation");
    const t24 = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "t24"));
    expect(t24.map((m) => m.recipient).sort()).toEqual([host.email, "korai@x.hu"].sort());
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "host_final_counts"))).length).toBe(1);
  });
});
