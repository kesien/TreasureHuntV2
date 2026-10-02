import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessSessions, emailDeliveries, events, hosts, teams } from "../src/db/schema.js";
import { decrypt } from "../src/lib/crypto.js";
import type { MailTransport, OutgoingMail } from "../src/services/mailer.js";
import { manualResend, processDue } from "../src/services/outbox.js";
import { buildContent, render } from "../src/services/templates.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); });

const hour = 3600_000;
const ADMIN_ID = crypto.randomUUID();
async function openEvent(over: Partial<typeof events.$inferInsert> = {}) {
  const now = Date.now();
  const [ev] = await ctx.db.insert(events).values({
    name: "Halloween", type: "halloween", status: "registration_open",
    registrationStart: new Date(now - hour), registrationClose: new Date(now + 24 * hour),
    modificationDeadline: new Date(now + 48 * hour), plannedStart: new Date(now + 72 * hour), plannedEnd: new Date(now + 76 * hour), ...over,
  }).returning();
  return ev!;
}

const teamBody = (over: Record<string, unknown> = {}) => ({
  name: "Dínók", contactName: "Kovács Anna", email: "anna@example.hu", phone: "0630 123 4567", consent: true,
  members: [{ name: "Panni", category: "child" }, { name: "Anna", category: "adult" }], ...over,
});
const post = (url: string, payload: unknown, key = "key-" + Math.random().toString(36).slice(2), headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: "POST", url, payload: payload as object, headers: { "idempotency-key": key, ...headers } });

class FakeTransport implements MailTransport {
  sent: OutgoingMail[] = [];
  failTimes = 0;
  async send(m: OutgoingMail) {
    if (this.failTimes > 0) { this.failTimes--; throw new Error("SMTP down"); }
    this.sent.push(m);
  }
}

async function adminHeaders() {
  const a = await createActiveAdmin(ctx);
  const s = await loginAdmin(ctx, a);
  return { cookie: s.cookie, "x-csrf-token": s.csrf };
}

describe("csapat jelentkezés", () => {
  it("sikeres jelentkezés, normalizált telefon, Függőben, visszaigazoló e-mail PIN/link nélkül", async () => {
    const ev = await openEvent();
    const r = await post(`/api/public/events/${ev.id}/teams`, teamBody());
    expect(r.statusCode).toBe(201);
    const [t] = await ctx.db.select().from(teams);
    expect(t!.phone).toBe("+36301234567");
    expect(t!.status).toBe("pending");
    const mails = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "application_received"));
    expect(mails.length).toBe(1);
    const body = JSON.parse(decrypt(mails[0]!.bodyEnc!, ctx.cfg.APP_SECRET));
    expect(body.text).not.toMatch(/PIN:/);
  });

  it("dupla beküldés ugyanazzal a kulccsal egyetlen jelentkezést hoz létre", async () => {
    const ev = await openEvent();
    const [a, b] = await Promise.all([post(`/api/public/events/${ev.id}/teams`, teamBody(), "same-key-1"), post(`/api/public/events/${ev.id}/teams`, teamBody(), "same-key-1")]);
    expect([a.statusCode, b.statusCode].every((c) => c === 200 || c === 201)).toBe(true);
    expect((await ctx.db.select().from(teams)).length).toBe(1);
  });

  it("gyermek nélkül, foglalt névvel, hibás telefonnal, hozzájárulás nélkül elutasít", async () => {
    const ev = await openEvent();
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody({ members: [{ name: "A", category: "adult" }] }))).json().error).toBe("child_required");
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody({ phone: "123456" }))).json().error).toBe("invalid_phone");
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody({ consent: false }))).json().error).toBe("consent_required");
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody())).statusCode).toBe(201);
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody({ name: "dínók", email: "masik@example.hu" }))).json().error).toBe("name_taken");
  });

  it("azonos e-mail több csapatnál használható", async () => {
    const ev = await openEvent();
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody())).statusCode).toBe(201);
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody({ name: "Másik" }))).statusCode).toBe(201);
  });

  it("zárt jelentkezésnél 409", async () => {
    const ev = await openEvent({ status: "preparation" });
    expect((await post(`/api/public/events/${ev.id}/teams`, teamBody())).statusCode).toBe(409);
  });

  it("Idempotency-Key nélkül hiba", async () => {
    const ev = await openEvent();
    const r = await ctx.app.inject({ method: "POST", url: `/api/public/events/${ev.id}/teams`, payload: teamBody() });
    expect(r.json().error).toBe("idempotency_required");
  });
});

describe("host jelentkezés", () => {
  const hostBody = (over: Record<string, unknown> = {}) => ({
    contactName: "Nagy Béla", email: "bela@example.hu", phone: "+36 20 111 2233", address: "Fő utca 12.", pickupMode: "gift_outside", consent: true, ...over,
  });
  it("cím egyedi (normalizálva)", async () => {
    const ev = await openEvent();
    expect((await post(`/api/public/events/${ev.id}/hosts`, hostBody())).statusCode).toBe(201);
    expect((await post(`/api/public/events/${ev.id}/hosts`, hostBody({ address: "fő u. 12" }))).json().error).toBe("address_taken");
    // ugyanaz a személy másik címmel is jelentkezhet
    expect((await post(`/api/public/events/${ev.id}/hosts`, hostBody({ address: "Kert utca 3." }))).statusCode).toBe(201);
  });
});

describe("jóváhagyás és hozzáférés", () => {
  it("jóváhagyás → e-mail link+PIN → belépés; küldés után az érzékeny törzs törlődik", async () => {
    const ev = await openEvent();
    await post(`/api/public/events/${ev.id}/teams`, teamBody());
    const [t] = await ctx.db.select().from(teams);
    const h = await adminHeaders();

    const noReason = await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/reject`, headers: h, payload: { reason: " " } });
    expect(noReason.statusCode).toBe(400);

    const ap = await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/approve`, headers: h });
    expect(ap.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/approve`, headers: h })).statusCode).toBe(409);

    const fake = new FakeTransport();
    await processDue(ctx.db, ctx.cfg, fake, 50);
    const mail = fake.sent.find((m) => m.subject.startsWith("Jóváhagyva"))!;
    expect(mail).toBeTruthy();
    const token = mail.text.match(/belepes\/([\w-]+)/)![1]!;
    const pin = mail.text.match(/PIN: (\d{6})/)![1]!;

    const login = await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token, pin } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const me = await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie } });
    expect(me.json().counts).toEqual({ children: 1, adults: 1, total: 2 });

    const [row] = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "approval"));
    expect(row!.status).toBe("sent");
    expect(row!.bodyEnc).toBeNull();
    await expect(manualResend(ctx.db, ADMIN_ID, row!.id)).rejects.toThrow(/Érzékeny/);
  });

  it("elutasítás indokkal; indokot az e-mail tartalmazza", async () => {
    const ev = await openEvent();
    await post(`/api/public/events/${ev.id}/teams`, teamBody());
    const [t] = await ctx.db.select().from(teams);
    const h = await adminHeaders();
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/reject`, headers: h, payload: { reason: "Betelt a létszám" } })).statusCode).toBe(200);
    const fake = new FakeTransport();
    await processDue(ctx.db, ctx.cfg, fake, 50);
    expect(fake.sent.some((m) => m.text.includes("Betelt a létszám"))).toBe(true);
  });

  it("elindult eseménynél a függő nem hagyható jóvá", async () => {
    const ev = await openEvent();
    await post(`/api/public/events/${ev.id}/teams`, teamBody());
    await ctx.db.update(events).set({ status: "active" });
    const [t] = await ctx.db.select().from(teams);
    const h = await adminHeaders();
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/approve`, headers: h })).statusCode).toBe(409);
  });

  it("határidő után jóváhagyott host: késői figyelmeztetés", async () => {
    const ev = await openEvent({ modificationDeadline: new Date(Date.now() - 1000), plannedStart: new Date(Date.now() + 10 * hour), plannedEnd: new Date(Date.now() + 14 * hour), registrationClose: new Date(Date.now() + hour) });
    await post(`/api/public/events/${ev.id}/hosts`, { contactName: "B", email: "b@example.hu", phone: "+36201112233", address: "Fő utca 1.", pickupMode: "ring_bell", consent: true });
    const [h0] = await ctx.db.select().from(hosts);
    await ctx.db.update(hosts).set({ latitude: 47.5, longitude: 19.0, locationConfirmed: true });
    const h = await adminHeaders();
    const r = await ctx.app.inject({ method: "POST", url: `/api/admin/hosts/${h0!.id}/approve`, headers: h });
    expect(r.json().late).toBe(true);
    expect(r.json().warnings.length).toBe(1);
  });
});

async function approvedTeam(over: Partial<typeof events.$inferInsert> = {}) {
  const ev = await openEvent(over);
  await post(`/api/public/events/${ev.id}/teams`, teamBody());
  const [t] = await ctx.db.select().from(teams);
  const h = await adminHeaders();
  await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${t!.id}/approve`, headers: h });
  const fake = new FakeTransport();
  await processDue(ctx.db, ctx.cfg, fake, 50);
  const mail = fake.sent.find((m) => m.subject.startsWith("Jóváhagyva"))!;
  const login = await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token: mail.text.match(/belepes\/([\w-]+)/)![1], pin: mail.text.match(/PIN: (\d{6})/)![1] } });
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { ev, t: t!, cookie, csrf: login.json().csrfToken as string, token: mail.text.match(/belepes\/([\w-]+)/)![1]!, fake };
}

describe("módosítás és visszalépés", () => {
  it("határidőig módosítható; számlálók frissülnek; gyerek nélkül nem", async () => {
    const s = await approvedTeam();
    const hd = { cookie: s.cookie, "x-csrf-token": s.csrf };
    const ok = await ctx.app.inject({ method: "PATCH", url: "/api/access/team", headers: hd, payload: { members: [{ name: "A", category: "child" }, { name: "B", category: "child" }, { name: "C", category: "adult" }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().counts).toEqual({ children: 2, adults: 1, total: 3 });
    const bad = await ctx.app.inject({ method: "PATCH", url: "/api/access/team", headers: hd, payload: { members: [{ name: "C", category: "adult" }] } });
    expect(bad.json().error).toBe("child_required");
  });

  it("határidő után nem módosítható és nem léphet vissza", async () => {
    const s = await approvedTeam();
    await ctx.db.update(events).set({ modificationDeadline: new Date(Date.now() - 1000), registrationClose: new Date(Date.now() - 2000) }).where(eq(events.id, s.ev.id));
    const hd = { cookie: s.cookie, "x-csrf-token": s.csrf };
    expect((await ctx.app.inject({ method: "PATCH", url: "/api/access/team", headers: hd, payload: { name: "Új" } })).json().error).toBe("deadline_passed");
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/team/withdraw", headers: hd, payload: { confirm: true } })).json().error).toBe("deadline_passed");
  });

  it("visszalépés megerősítéssel: státusz, hozzáférés azonnal letiltva, admin értesítés", async () => {
    const s = await approvedTeam();
    const hd = { cookie: s.cookie, "x-csrf-token": s.csrf };
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/team/withdraw", headers: hd, payload: { confirm: false } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/team/withdraw", headers: hd, payload: { confirm: true } })).statusCode).toBe(200);
    const [t] = await ctx.db.select().from(teams);
    expect(t!.status).toBe("withdrawn");
    expect((await ctx.db.select().from(accessSessions)).length).toBe(0);
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token: s.token, pin: "000000" } })).statusCode).toBe(400);
    const adminMails = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "admin_notice"));
    expect(adminMails.length).toBeGreaterThan(0);
  });

  it("e-mail csere: megerősítésig a régi marad", async () => {
    const s = await approvedTeam();
    const hd = { cookie: s.cookie, "x-csrf-token": s.csrf };
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/team/email-change", headers: hd, payload: { email: "uj@example.hu" } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(teams))[0]!.email).toBe("anna@example.hu");
    const fake = new FakeTransport();
    await processDue(ctx.db, ctx.cfg, fake, 50);
    const mail = fake.sent.find((m) => m.to === "uj@example.hu")!;
    const token = mail.text.match(/email-megerosites\/([\w-]+)/)![1];
    expect((await ctx.app.inject({ method: "POST", url: "/api/public/email-change/confirm", payload: { token } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(teams))[0]!.email).toBe("uj@example.hu");
    expect((await ctx.app.inject({ method: "POST", url: "/api/public/email-change/confirm", payload: { token } })).statusCode).toBe(400);
  });
});

describe("PIN helyreállítás", () => {
  it("ismeretlen e-mailre is azonos válasz; valósra levél; új PIN minden sessiont érvénytelenít", async () => {
    const s = await approvedTeam();
    const unknown = await ctx.app.inject({ method: "POST", url: "/api/public/pin-recovery/request", payload: { email: "nincs@example.hu" } });
    const known = await ctx.app.inject({ method: "POST", url: "/api/public/pin-recovery/request", payload: { email: "anna@example.hu" } });
    expect(unknown.json()).toEqual(known.json());
    const fake = new FakeTransport();
    await processDue(ctx.db, ctx.cfg, fake, 50);
    expect(fake.sent.filter((m) => m.to === "nincs@example.hu").length).toBe(0);
    const mail = fake.sent.find((m) => m.subject.startsWith("PIN visszaállítása"))!;
    const token = mail.text.match(/pin-visszaallitas\/([\w-]+)/)![1];
    expect((await ctx.app.inject({ method: "POST", url: "/api/public/pin-recovery/complete", payload: { token, pin: "123456", pinAgain: "123456" } })).json().error).toBe("weak_pin");
    expect((await ctx.app.inject({ method: "POST", url: "/api/public/pin-recovery/complete", payload: { token, pin: "739204", pinAgain: "739204" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie: s.cookie } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token: s.token, pin: "739204" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/public/pin-recovery/complete", payload: { token, pin: "739204", pinAgain: "739204" } })).statusCode).toBe(400); // egyszer használható
  });
});

describe("e-mail outbox", () => {
  it("hiba esetén újrapróbál; DB adat megmarad; sikertelen státusz 5 próba után", async () => {
    const ev = await openEvent();
    await post(`/api/public/events/${ev.id}/teams`, teamBody());
    expect((await ctx.db.select().from(teams)).length).toBe(1);
    const fail = new FakeTransport();
    fail.failTimes = 100;
    for (let i = 0; i < 5; i++) {
      await ctx.db.update(emailDeliveries).set({ nextAttemptAt: new Date(0) });
      await processDue(ctx.db, ctx.cfg, fail, 50);
    }
    const rows = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "application_received"));
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.attempts).toBe(5);
    expect(rows[0]!.lastError).toBe("SMTP down");
    expect((await ctx.db.select().from(teams)).length).toBe(1);
  });

  it("kézi újraküldés percenként legfeljebb egyszer", async () => {
    const ev = await openEvent();
    await post(`/api/public/events/${ev.id}/teams`, teamBody());
    await processDue(ctx.db, ctx.cfg, new FakeTransport(), 50);
    const [m] = await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "application_received"));
    await manualResend(ctx.db, ADMIN_ID, m!.id);
    await expect(manualResend(ctx.db, ADMIN_ID, m!.id)).rejects.toThrow(/Percenként/);
  });

  it("azonos dedup kulcs nem duplikál", async () => {
    const { enqueueEmail } = await import("../src/services/outbox.js");
    const a = await enqueueEmail(ctx.db, ctx.cfg, { type: "t24", recipient: "x@example.hu", data: {}, dedupKey: "t24:1" });
    const b = await enqueueEmail(ctx.db, ctx.cfg, { type: "t24", recipient: "x@example.hu", data: {}, dedupKey: "t24:1" });
    expect([a, b]).toEqual([true, false]);
  });
});

describe("sablonok és publikus oldal", () => {
  it("minden sablon renderel HTML + szöveg", () => {
    const types = ["application_received", "approval", "rejection", "t24", "event_started", "station_warning", "station_removal", "withdrawal", "event_cancellation", "host_final_counts", "password_reset", "admin_invitation", "pin_recovery"] as const;
    for (const t of types) {
      const c = render(buildContent(t, { eventName: "E", link: "https://x/y", pin: "481952", reason: "ok", stationNumber: 3 }));
      expect(c.html).toContain("<html lang=\"hu\">");
      expect(c.text.length).toBeGreaterThan(10);
    }
  });
  it("HTML-ben escape-elt a felhasználói tartalom", () => {
    const c = render(buildContent("rejection", { reason: "<script>alert(1)</script>" }));
    expect(c.html).not.toContain("<script>");
  });
  it("publikus esemény nem tartalmaz állomásadatot; draft rejtett", async () => {
    const ev = await openEvent();
    await openEvent({ name: "Draft", status: "draft" });
    const list = (await ctx.app.inject({ method: "GET", url: "/api/public/events" })).json();
    expect(list.length).toBe(1);
    expect(Object.keys(list[0]).some((k) => /station|address|lat|lon/i.test(k))).toBe(false);
    expect((await ctx.app.inject({ method: "GET", url: `/api/public/events/${ev.id}` })).statusCode).toBe(200);
  });
});
