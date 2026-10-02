import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, hosts, stations } from "../src/db/schema.js";
import { geocodeAddress, GoogleGeocoderProvider, type GeocoderProvider } from "../src/services/geocode.js";
import { googleUsage, reserveGoogleCall } from "../src/services/googleQuota.js";
import { systemStatus } from "../src/services/adminOps.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";

const queries: string[] = [];
const fake: GeocoderProvider = {
  name: "fake",
  async search(a) { queries.push(a); return a.includes("Nincs") ? null : { lat: 47.5, lon: 19.0, label: a, provider: "fake", placeId: "pid-1" }; },
};

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([fake]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); queries.length = 0; });

const hour = 3600_000;
async function mkEvent(over: Partial<typeof events.$inferInsert> = {}) {
  const now = Date.now();
  const [ev] = await ctx.db.insert(events).values({
    name: "E", type: "halloween", status: "registration_open", locality: "Derekegyháza", centerLat: 46.5, centerLon: 20.3,
    registrationStart: new Date(now - hour), registrationClose: new Date(now + 5 * hour), modificationDeadline: new Date(now + 10 * hour),
    plannedStart: new Date(now + 72 * hour), plannedEnd: new Date(now + 76 * hour), ...over,
  }).returning();
  return ev!;
}
const googleResp = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

describe("GoogleGeocoderProvider", () => {
  it("találat → koordináta + place ID; a kérés magyar, HU-ra szűkített", async () => {
    let url = "";
    const p = new GoogleGeocoderProvider("KEY", async () => true, (async (u: string) => { url = u; return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Fő u. 12.", place_id: "ChIJ1", geometry: { location: { lat: 46.51, lng: 20.31 } } }] })); }) as unknown as typeof fetch);
    expect(await p.search("Fő utca 12., Derekegyháza")).toMatchObject({ lat: 46.51, lon: 20.31, placeId: "ChIJ1", provider: "google" });
    expect(url).toContain("components=country:HU");
    expect(url).toContain("language=hu");
  });
  it("ZERO_RESULTS → null; egyéb státusz és HTTP-hiba → hiba (a lánc továbblép)", async () => {
    expect(await new GoogleGeocoderProvider("K", async () => true, googleResp({ status: "ZERO_RESULTS", results: [] })).search("x")).toBeNull();
    await expect(new GoogleGeocoderProvider("K", async () => true, googleResp({ status: "REQUEST_DENIED" })).search("x")).rejects.toThrow(/REQUEST_DENIED/);
    await expect(new GoogleGeocoderProvider("K", async () => true, googleResp({}, false)).search("x")).rejects.toThrow(/http 500/);
  });
  it("plafon elérve → nincs hálózati hívás, hiba", async () => {
    let called = 0;
    const p = new GoogleGeocoderProvider("K", async () => false, (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch);
    await expect(p.search("x")).rejects.toThrow(/limit/);
    expect(called).toBe(0);
  });
});

describe("havi Google plafon", () => {
  it("a plafonig enged, utána tilt; új hónapban újraindul", async () => {
    const jan = new Date("2026-01-15T10:00:00Z");
    expect(await reserveGoogleCall(ctx.db, 2, jan)).toBe(true);
    expect(await reserveGoogleCall(ctx.db, 2, jan)).toBe(true);
    expect(await reserveGoogleCall(ctx.db, 2, jan)).toBe(false);
    expect(await googleUsage(ctx.db, jan)).toEqual({ month: "2026-01", count: 2 });
    expect(await reserveGoogleCall(ctx.db, 2, new Date("2026-02-01T00:00:00Z"))).toBe(true);
    expect(await googleUsage(ctx.db, new Date("2026-02-01T00:00:00Z"))).toEqual({ month: "2026-02", count: 1 });
  });
  it("a lánc a plafon után a tartalék szolgáltatóra lép, és a placeId megmarad", async () => {
    let n = 0;
    const google = new GoogleGeocoderProvider("K", async () => n++ < 1, googleResp({ status: "OK", results: [{ formatted_address: "A", place_id: "G1", geometry: { location: { lat: 1, lng: 2 } } }] }));
    expect(await geocodeAddress(ctx.db, [google, fake], "Első utca 1.")).toMatchObject({ provider: "google", placeId: "G1" });
    expect(await geocodeAddress(ctx.db, [google, fake], "Második utca 2.")).toMatchObject({ provider: "fake" });
  });
  it("a rendszerállapot figyelmeztet a plafon 80%-ánál", async () => {
    const cfg = { ...ctx.cfg, GOOGLE_GEOCODING_API_KEY: "K", GOOGLE_GEOCODING_MONTHLY_LIMIT: 10 };
    for (let i = 0; i < 8; i++) await reserveGoogleCall(ctx.db, 10);
    const st = await systemStatus(ctx.db, cfg);
    expect(st.checks.geocoding).toMatchObject({ level: "warning" });
    expect(st.checks.geocoding!.detail).toContain("8/10");
  });
});

describe("nyilvános geokódolás és host-jelentkezés megerősített pozícióval", () => {
  const hostBody = (extra: object = {}) => ({
    contactName: "Nagy Béla", email: "bela@example.hu", phone: "+36 20 111 2233", address: "Fő utca 12.", pickupMode: "gift_outside", consent: true, ...extra,
  });
  const apply = (eventId: string, body: object, key = "k-" + Math.random().toString(36).slice(2, 12)) =>
    ctx.app.inject({ method: "POST", url: `/api/public/events/${eventId}/hosts`, headers: { "idempotency-key": key }, payload: body });

  it("munkamenet nélkül működik, a települést hozzáfűzi, csak nyitott jelentkezésnél, és korlátozott", async () => {
    const ev = await mkEvent();
    const r = await ctx.app.inject({ method: "POST", url: `/api/public/events/${ev.id}/geocode`, payload: { address: "Fő utca 12." } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ found: true, placeId: "pid-1", center: { lat: 46.5, lon: 20.3 } });
    expect(queries).toEqual(["Fő utca 12., Derekegyháza"]);

    const closed = await mkEvent({ status: "preparation" });
    expect((await ctx.app.inject({ method: "POST", url: `/api/public/events/${closed.id}/geocode`, payload: { address: "Fő utca 12." } })).statusCode).toBe(409);

    let last = 200;
    for (let i = 0; i < 25 && last === 200; i++) last = (await ctx.app.inject({ method: "POST", url: `/api/public/events/${ev.id}/geocode`, payload: { address: `Teszt utca ${i}.` } })).statusCode;
    expect(last).toBe(429);
  });

  it("a host által megerősített pozícióval jelentkezés → az admin a térkép-megerősítés nélkül jóváhagyhatja", async () => {
    const ev = await mkEvent();
    const r = await apply(ev.id, hostBody({ location: { lat: 46.5005, lon: 20.3005, placeId: "ChIJhost" } }));
    expect(r.statusCode).toBe(201);
    const [h] = await ctx.db.select().from(hosts).where(eq(hosts.id, r.json().id));
    expect(h).toMatchObject({ locationConfirmed: true, latitude: 46.5005, longitude: 20.3005, placeId: "ChIJhost" });

    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const ap = await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${h!.id}/approve`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(ap.statusCode).toBe(200);
    const [st] = await ctx.db.select().from(stations).where(eq(stations.hostId, h!.id));
    expect(st).toMatchObject({ latitude: 46.5005, longitude: 20.3005 });
  });

  it("az eseményközponttól >50 km-re lévő pozíció elutasítva; pozíció nélküli jelentkezés admin-megerősítést kér", async () => {
    const ev = await mkEvent();
    const far = await apply(ev.id, hostBody({ location: { lat: 47.5, lon: 19.04 } })); // Budapest ~130 km
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toBe("invalid_location");

    const none = await apply(ev.id, hostBody({ email: "masik@example.hu", address: "Kossuth utca 3." }));
    expect(none.statusCode).toBe(201);
    const [h] = await ctx.db.select().from(hosts).where(eq(hosts.id, none.json().id));
    expect(h!.locationConfirmed).toBe(false);
    const a = await createActiveAdmin(ctx, "a2@example.hu");
    const s = await loginAdmin(ctx, a);
    const ap = await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${h!.id}/approve`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(ap.statusCode).toBe(409);
  });

  it("a nyilvános konfig a Google kulcsot és a map ID-t adja, a CSP engedi a Google origineket", async () => {
    const cfg = (await ctx.app.inject({ method: "GET", url: "/api/public/config" })).json();
    expect(cfg).toMatchObject({ timezone: "Europe/Budapest" });
    expect(cfg).toHaveProperty("googleMapsApiKey");
    expect(cfg).toHaveProperty("mapId");
    const csp = (await ctx.app.inject({ method: "GET", url: "/api/health" })).headers["content-security-policy"] as string;
    expect(csp).toContain("script-src 'self' https://maps.googleapis.com");
    expect(csp).toContain("https://maps.gstatic.com");
  });
});
