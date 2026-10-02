import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessSessions, auditLogs, events, hosts, teams, teamMembers } from "../src/db/schema.js";
import { accessLogin, changePin, createCredential, getAccessSession, regenerateLink, accessLogout } from "../src/services/accessAuth.js";
import { createActiveAdmin, eventPayload, loginAdmin, PASSWORD, resetDb, setup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); });

describe("admin auth", () => {
  it("meghívás → aktiváció → belépés TOTP-vel; CSRF kötelező", async () => {
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const me = await ctx.app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(200);
    const noCsrf = await ctx.app.inject({ method: "POST", url: "/api/admin/logout", headers: { cookie: s.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: "POST", url: "/api/admin/logout", headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(ok.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: s.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("hibás jelszó / TOTP általános hibát ad és auditálódik", async () => {
    const a = await createActiveAdmin(ctx);
    const bad = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: a.email, password: "rossz-jelszo-123", totp: "000000" } });
    expect(bad.statusCode).toBe(400);
    const unknown = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "nincs@example.hu", password: PASSWORD, totp: "000000" } });
    expect(unknown.json().message).toBe(bad.json().message);
    const rows = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "admin.login_failed"));
    expect(rows.length).toBe(2);
  });

  it("helyreállító kód egyszer használható és auditált", async () => {
    const a = await createActiveAdmin(ctx);
    const body = { email: a.email, password: PASSWORD, recoveryCode: a.recoveryCodes[0] };
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: body })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: body })).statusCode).toBe(400);
    const rows = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "admin.2fa_recovery_used"));
    expect(rows.length).toBe(1);
  });

  it("5 hibás próba után zárol", async () => {
    const a = await createActiveAdmin(ctx);
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: a.email, password: "rossz-jelszo-123", totp: "000000" } });
    }
    const r = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: a.email, password: PASSWORD, totp: authenticator.generate(a.secret) } });
    expect(r.statusCode).toBe(429);
  });

  it("gyenge jelszót elutasít", async () => {
    const { inviteAdmin, beginActivation, completeActivation } = await import("../src/services/adminAuth.js");
    const { token } = await inviteAdmin(ctx.db, null, "x@example.hu", "X");
    const { secret } = await beginActivation(ctx.db, ctx.cfg, token);
    await expect(completeActivation(ctx.db, ctx.cfg, token, "rovid1", authenticator.generate(secret))).rejects.toThrow();
  });

  it("archivált admin nem tud belépni; az audit megmarad", async () => {
    const a1 = await createActiveAdmin(ctx, "a1@example.hu");
    const a2 = await createActiveAdmin(ctx, "a2@example.hu");
    const s1 = await loginAdmin(ctx, a1);
    const r = await ctx.app.inject({ method: "POST", url: `/api/admin/admins/${a2.adminId}/archive`, headers: { cookie: s1.cookie, "x-csrf-token": s1.csrf } });
    expect(r.statusCode).toBe(200);
    const l = await ctx.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: a2.email, password: PASSWORD, totp: authenticator.generate(a2.secret) } });
    expect(l.statusCode).toBe(400);
  });

  it("az audit napló nem módosítható és nem törölhető", async () => {
    await createActiveAdmin(ctx);
    await expect(ctx.db.delete(auditLogs)).rejects.toThrow();
    await expect(ctx.db.update(auditLogs).set({ action: "x" })).rejects.toThrow();
  });
});

async function makeTeam(ctx: Ctx) {
  const a = await createActiveAdmin(ctx);
  const [ev] = await ctx.db.insert(events).values({
    name: "E", type: "halloween", registrationStart: new Date(), registrationClose: new Date(Date.now() + 1e6),
    modificationDeadline: new Date(Date.now() + 2e6), plannedStart: new Date(Date.now() + 3e6), plannedEnd: new Date(Date.now() + 4e6),
  }).returning();
  const team = await ctx.db.transaction(async (tx) => {
    const [t] = await tx.insert(teams).values({ eventId: ev!.id, name: "Dínók", contactName: "K", email: "k@x.hu", phone: "+36301234567" }).returning();
    await tx.insert(teamMembers).values({ teamId: t!.id, name: "Gyerek", category: "child" });
    return t!;
  });
  return { admin: a, ev: ev!, team };
}

describe("team/host hozzáférés", () => {
  it("link + PIN belépés; több eszköz külön sessionnel; logout csak az aktuálisat szünteti meg", async () => {
    const { ev, team } = await makeTeam(ctx);
    const { token } = await createCredential(ctx.db, "team", team.id, ev.id, "481952");
    await expect(accessLogin(ctx.db, token, "000111", "1.1.1.1")).rejects.toThrow();
    const s1 = await accessLogin(ctx.db, token, "481952", "1.1.1.1");
    const s2 = await accessLogin(ctx.db, token, "481952", "1.1.1.2");
    await accessLogout(ctx.db, s1.sessionToken);
    expect(await getAccessSession(ctx.db, s1.sessionToken)).toBeNull();
    expect(await getAccessSession(ctx.db, s2.sessionToken)).not.toBeNull();
  });

  it("triviális PIN-t elutasít", async () => {
    const { ev, team } = await makeTeam(ctx);
    await expect(createCredential(ctx.db, "team", team.id, ev.id, "123456")).rejects.toThrow();
  });

  it("PIN csere minden sessiont érvénytelenít", async () => {
    const { ev, team } = await makeTeam(ctx);
    const { token } = await createCredential(ctx.db, "team", team.id, ev.id, "481952");
    const s1 = await accessLogin(ctx.db, token, "481952", "1.1.1.1");
    const s2 = await accessLogin(ctx.db, token, "481952", "1.1.1.2");
    await changePin(ctx.db, "team", team.id, "739204", { type: "team", id: team.id });
    expect(await getAccessSession(ctx.db, s1.sessionToken)).toBeNull();
    expect(await getAccessSession(ctx.db, s2.sessionToken)).toBeNull();
    await expect(accessLogin(ctx.db, token, "481952", "1.1.1.1")).rejects.toThrow();
    await expect(accessLogin(ctx.db, token, "739204", "1.1.1.1")).resolves.toBeTruthy();
  });

  it("link újragenerálás: régi link érvénytelen, PIN és sessionök maradnak", async () => {
    const { admin, ev, team } = await makeTeam(ctx);
    const { token } = await createCredential(ctx.db, "team", team.id, ev.id, "481952");
    const s1 = await accessLogin(ctx.db, token, "481952", "1.1.1.1");
    const { token: fresh } = await regenerateLink(ctx.db, "team", team.id, admin.adminId);
    await expect(accessLogin(ctx.db, token, "481952", "1.1.1.1")).rejects.toThrow();
    await expect(accessLogin(ctx.db, fresh, "481952", "1.1.1.1")).resolves.toBeTruthy();
    expect(await getAccessSession(ctx.db, s1.sessionToken)).not.toBeNull();
  });

  it("HTTP: belépés, süti, /me, csak az aktuális eszköz lép ki", async () => {
    const { ev, team } = await makeTeam(ctx);
    const { token } = await createCredential(ctx.db, "team", team.id, ev.id, "481952");
    const login = () => ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token, pin: "481952" } });
    const a = await login();
    const b = await login();
    expect(a.statusCode).toBe(200);
    const ca = a.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cb = b.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const out = await ctx.app.inject({ method: "POST", url: "/api/access/logout", headers: { cookie: ca, "x-csrf-token": a.json().csrfToken } });
    expect(out.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/me", headers: { cookie: ca } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/me", headers: { cookie: cb } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(accessSessions)).length).toBe(1);
  });

  it("csapat gyermek nélkül nem menthető (DB trigger)", async () => {
    const { ev } = await makeTeam(ctx);
    await expect(ctx.db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values({ eventId: ev.id, name: "Csak felnőtt", contactName: "K", email: "k@x.hu", phone: "+36301234567" }).returning();
      await tx.insert(teamMembers).values({ teamId: t!.id, name: "Felnőtt", category: "adult" });
    })).rejects.toThrow();
  });

  it("csapatnév egyedi eseményen belül (kis/nagybetű független)", async () => {
    const { ev } = await makeTeam(ctx);
    await expect(ctx.db.insert(teams).values({ eventId: ev.id, name: "dínók", contactName: "K", email: "k@x.hu", phone: "+36301234567" })).rejects.toThrow();
  });
});

describe("események", () => {
  it("létrehozás, hibás dátum, egyszerre egy aktív, start lejáratja a függőket, cancel visszavon", async () => {
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const h = { cookie: s.cookie, "x-csrf-token": s.csrf };

    const bad = await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: eventPayload({ plannedEnd: "2026-10-30T00:00:00Z" }) });
    expect(bad.statusCode).toBe(400);

    const e1 = (await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: eventPayload() })).json();
    const e2 = (await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: eventPayload({ name: "Másik" }) })).json();
    const go = (id: string, to: string, reason?: string) =>
      ctx.app.inject({ method: "POST", url: `/api/admin/events/${id}/transition`, headers: h, payload: { to, reason } });

    for (const id of [e1.id, e2.id]) {
      expect((await go(id, "registration_open")).statusCode).toBe(200);
      expect((await go(id, "preparation")).statusCode).toBe(200);
    }
    // jelentkezők e1-en
    await expect(ctx.db.insert(teams).values({ eventId: e1.id, name: "Függő", contactName: "K", email: "k@x.hu", phone: "+36301234567" }))
      .rejects.toThrow(); // gyerek nélküli csapatot a trigger megakadályozza; host-tal próbáljuk
    const [host] = await ctx.db.insert(hosts).values({
      eventId: e1.id, contactName: "H", email: "h@x.hu", phone: "+36301234567", address: "Fő u. 1.", normalizedAddress: "fo u 1", pickupMode: "ring_bell",
    }).returning();

    const start = await go(e1.id, "active");
    expect(start.statusCode).toBe(200);
    expect(start.json().expiredApplications).toBe(1);
    const [h2] = await ctx.db.select().from(hosts).where(eq(hosts.id, host!.id));
    expect(h2!.status).toBe("expired");

    expect((await go(e2.id, "active")).statusCode).toBe(409); // már van aktív

    expect((await go(e1.id, "cancelled")).statusCode).toBe(400); // indok nélkül nem
    expect((await go(e1.id, "cancelled", "Vihar")).statusCode).toBe(200);
    expect((await go(e1.id, "active")).statusCode).toBe(409); // végállapot
  });

  it("üres draft törölhető, jelentkezővel nem", async () => {
    const a = await createActiveAdmin(ctx);
    const s = await loginAdmin(ctx, a);
    const h = { cookie: s.cookie, "x-csrf-token": s.csrf };
    const e = (await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: eventPayload() })).json();
    await ctx.db.insert(hosts).values({ eventId: e.id, contactName: "H", email: "h@x.hu", phone: "+36301234567", address: "A", normalizedAddress: "a", pickupMode: "ring_bell" });
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/admin/events/${e.id}`, headers: h })).statusCode).toBe(409);
    const e2 = (await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: eventPayload({ name: "Üres" }) })).json();
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/admin/events/${e2.id}`, headers: h })).statusCode).toBe(200);
  });

  it("admin végpont bejelentkezés nélkül 401", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/events" })).statusCode).toBe(401);
  });
});
