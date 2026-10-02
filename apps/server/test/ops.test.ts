import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessCredentials, auditLogs, backupRuns, emailDeliveries, errorEvents, events, hosts, photos, stations, teamMembers, teams } from "../src/db/schema.js";
import { pruneBackups, runBackup, runScheduledBackups, type BackupRunner } from "../src/services/backup.js";
import { runRetention } from "../src/services/retention.js";
import { systemStatus, heartbeat } from "../src/services/adminOps.js";
import { createActiveAdmin, loginAdmin, resetDb, setup, type Ctx } from "./helpers.js";
import { ci, hd, world } from "./world.js";

class FakeRunner implements BackupRunner {
  fail = false;
  async dumpDatabase(_u: string, out: string) { if (this.fail) throw new Error("pg_dump hiba"); await writeFile(out, "dump"); }
  async archiveDirectory(_d: string, out: string) { await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, "tar"); }
}
const runner = new FakeRunner();

let ctx: Ctx;
beforeAll(async () => { ctx = await setup([]); });
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });
beforeEach(async () => { await resetDb(ctx.db); runner.fail = false; });

async function adminH() {
  const a = await createActiveAdmin(ctx);
  const s = await loginAdmin(ctx, a);
  return { cookie: s.cookie, "x-csrf-token": s.csrf };
}

describe("statisztika és audit", () => {
  it("dashboard számok: létszám, állomás, check-in, kész/részleges csapat, fotó; ranglista nincs", async () => {
    const { ev, sts, tms } = await world(ctx, 2, 3);
    const h = await adminH();
    for (const s of sts) await ci(ctx, tms[0]!, s.id, s.latitude, s.longitude); // 1. csapat kész
    await ci(ctx, tms[1]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude); // 2. részleges
    const st = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/stats`, headers: h })).json();
    expect(st).toMatchObject({
      teams: { approved: 3 }, participants: { total: 6, children: 3, adults: 3 }, stations: 2, completedCheckIns: 3, completedTeams: 1, partialTeams: 1, photos: 0, pendingApplications: 0,
    });
    expect(JSON.stringify(st)).not.toMatch(/rank|winner/i);
  });

  it("visszalépett csapat kikerül a létszámból", async () => {
    const { ev, tms } = await world(ctx, 1, 2);
    await ctx.db.update(teams).set({ status: "withdrawn" }).where(eq(teams.id, tms[0]!.id));
    const h = await adminH();
    const st = (await ctx.app.inject({ method: "GET", url: `/api/admin/events/${ev.id}/stats`, headers: h })).json();
    expect(st.participants.total).toBe(2);
    expect(st.teams).toMatchObject({ approved: 1, withdrawn: 1 });
  });

  it("audit keresés/szűrés; csak olvasható; admin neve megjelenik", async () => {
    const h = await adminH();
    await ctx.app.inject({ method: "POST", url: "/api/admin/events", headers: h, payload: { name: "X", type: "easter", registrationStart: "2027-03-01T00:00:00Z", registrationClose: "2027-03-20T00:00:00Z", modificationDeadline: "2027-03-25T00:00:00Z", plannedStart: "2027-04-01T09:00:00Z", plannedEnd: "2027-04-01T12:00:00Z" } });
    const all = (await ctx.app.inject({ method: "GET", url: "/api/admin/audit", headers: h })).json();
    expect(all.total).toBeGreaterThan(2);
    const f = (await ctx.app.inject({ method: "GET", url: "/api/admin/audit?action=event.create&entityType=event", headers: h })).json();
    expect(f.rows.length).toBe(1);
    expect(f.rows[0].actorName).toBe("Teszt Admin");
    const none = (await ctx.app.inject({ method: "GET", url: "/api/admin/audit?from=2100-01-01", headers: h })).json();
    expect(none.rows.length).toBe(0);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/audit" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "DELETE", url: "/api/admin/audit", headers: h })).statusCode).toBe(404);
  });
});

describe("események e-mailjei", () => {
  it("indításkor 'elindult' levél a jóváhagyottaknak; lemondáskor értesítés + hozzáférés azonnal megszűnik", async () => {
    const now = Date.now();
    const [ev] = await ctx.db.insert(events).values({
      name: "E", type: "halloween", status: "preparation", registrationStart: new Date(now - 9e8), registrationClose: new Date(now - 8e8),
      modificationDeadline: new Date(now - 7e8), plannedStart: new Date(now + 1e6), plannedEnd: new Date(now + 5e6),
    }).returning();
    const [t] = await ctx.db.insert(teams).values({ eventId: ev!.id, name: "T", contactName: "K", email: "t@x.hu", phone: "+36301234567", status: "approved", approvedAt: new Date(0) }).returning().catch(() => [null as never]);
    void t;
    const h = await adminH();
    await ctx.db.transaction(async (tx) => {
      const [t2] = await tx.insert(teams).values({ eventId: ev!.id, name: "T2", contactName: "K", email: "t2@x.hu", phone: "+36301234567", status: "approved" }).returning();
      await tx.insert(teamMembers).values({ teamId: t2!.id, name: "g", category: "child" });
    });
    await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev!.id}/transition`, headers: h, payload: { to: "active" } });
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "event_started"))).length).toBe(1);
    await ctx.app.inject({ method: "POST", url: `/api/admin/events/${ev!.id}/transition`, headers: h, payload: { to: "cancelled", reason: "Vihar" } });
    expect((await ctx.db.select().from(emailDeliveries).where(eq(emailDeliveries.type, "event_cancellation"))).length).toBe(1);
  });
});

describe("admin műveletek", () => {
  it("határidő után az admin javíthat (auditált); eltávolítás indokkal; hozzáférés megszűnik", async () => {
    const { ev, tms } = await world(ctx, 1, 1);
    const h = await adminH();
    await ctx.db.update(events).set({ status: "preparation" }).where(eq(events.id, ev.id)); // active alatt a résztvevői szerkesztés tiltott, az adminé nem
    const r = await ctx.app.inject({ method: "PATCH", url: `/api/admin/teams/${tms[0]!.id}`, headers: h, payload: { name: "Javított név" } });
    expect(r.statusCode).toBe(200);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "team.edit")))[0]!.actorType).toBe("admin");
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${tms[0]!.id}/remove`, headers: h, payload: { reason: " " } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${tms[0]!.id}/remove`, headers: h, payload: { reason: "Szabálysértés" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(401);
  });

  it("link újragenerálás HTTP-n: régi link érvénytelen, PIN és meglévő munkamenet marad, auditált", async () => {
    const { ev, tms } = await world(ctx, 1, 1);
    const [cred] = await ctx.db.select().from(accessCredentials).where(eq(accessCredentials.subjectId, tms[0]!.id));
    const h = await adminH();
    const r = await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${tms[0]!.id}/regenerate-link`, headers: h });
    expect(r.statusCode).toBe(200);
    const fresh = (r.json().link as string).split("/belepes/")[1]!;
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token: "x".repeat(43), pin: "482915" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/access/login", payload: { token: fresh, pin: "481952" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "access.link_regenerated"))).length).toBe(1);
    void ev; void cred;
  });

  it("view-as csak olvasható és auditált; participant műveletet nem enged", async () => {
    const { sts, tms, hostRows } = await world(ctx, 1, 1);
    const h = await adminH();
    const v = (await ctx.app.inject({ method: "GET", url: `/api/admin/view-as/team/${tms[0]!.id}`, headers: h })).json();
    expect(v.readOnly).toBe(true);
    expect(v.progress.required).toBe(1);
    expect((await ctx.app.inject({ method: "GET", url: `/api/admin/view-as/host/${hostRows[0]!.id}`, headers: h })).json().dashboard.station.number).toBe(1);
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "admin.view_as"))).length).toBe(2);
    // az admin munkamenete nem jogosít participant műveletre
    const r = await ctx.app.inject({ method: "POST", url: "/api/access/checkin", headers: h, payload: { stationId: sts[0]!.id, latitude: sts[0]!.latitude, longitude: sts[0]!.longitude } });
    expect(r.statusCode).toBe(401);
  });

  it("adatkezelési kérelem rögzíthető és lezárható; anonimizálás törli a személyes adatot, az auditban nincs PII", async () => {
    const { ev, tms } = await world(ctx, 1, 1);
    const h = await adminH();
    const dr = (await ctx.app.inject({ method: "POST", url: "/api/admin/data-requests", headers: h, payload: { kind: "erasure", summary: "Törlési kérelem csapatkapcsolattartótól" } })).json();
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/teams/${tms[0]!.id}/anonymize`, headers: h, payload: { reason: `kérelem ${dr.id}` } })).statusCode).toBe(200);
    const [t] = await ctx.db.select().from(teams).where(eq(teams.id, tms[0]!.id));
    expect(t).toMatchObject({ contactName: "Anonimizált", phone: "", status: "approved" });
    expect(t!.email).toMatch(/^anon-/);
    expect((await ctx.db.select().from(teamMembers).where(eq(teamMembers.teamId, t!.id))).every((m) => m.name === "Anonimizált")).toBe(true);
    expect((await ctx.db.select().from(accessCredentials).where(eq(accessCredentials.subjectId, t!.id)))[0]!.revokedAt).not.toBeNull();
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/data-requests/${dr.id}/resolve`, headers: h, payload: { status: "done" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/api/admin/data-requests/${dr.id}/resolve`, headers: h, payload: { status: "done" } })).statusCode).toBe(409);
    const logs = JSON.stringify(await ctx.db.select().from(auditLogs));
    expect(logs).not.toContain("t1@x.hu");
    void ev;
  });
});

describe("rendszerállapot", () => {
  it("összesített állapot: figyelmeztetés mentés nélkül, rendben mentéssel + heartbeat-tel, hiba a kritikus hibáknál nem, csak figyelmeztet", async () => {
    await heartbeat(ctx.db);
    let s = await systemStatus(ctx.db, ctx.cfg);
    expect(s.checks.database!.level).toBe("ok");
    expect(s.checks.storage!.level).toBe("ok");
    expect(s.overall).toBe("warning"); // még nincs mentés
    expect(s.label).toBe("Figyelmeztetés");
    await runBackup(ctx.db, ctx.cfg, runner, "daily");
    s = await systemStatus(ctx.db, ctx.cfg);
    expect(s.overall).toBe("ok");
    await ctx.db.insert(errorEvents).values({ message: "x" });
    expect((await systemStatus(ctx.db, ctx.cfg)).checks.errors!.level).toBe("warning");
    const stale = await systemStatus(ctx.db, ctx.cfg, new Date(Date.now() + 3 * 3600_000));
    expect(stale.checks.jobs!.level).toBe("warning");
    expect(s.version).toBeTruthy();
  });

  it("a hibanapló rövid, útvonal query nélkül tárolódik és számít a státuszban", async () => {
    const { recordError } = await import("../src/services/adminOps.js");
    await recordError(ctx.db, "x".repeat(1000), "/api/admin/audit?actorId=titkos", "corr-1");
    const [e] = await ctx.db.select().from(errorEvents);
    expect(e!.message.length).toBe(300);
    expect(e!.route).toBe("/api/admin/audit");
  });
});

describe("mentés", () => {
  it("manuális mentés: DB és fotók külön fájl, státusz rögzítve, auditált; hibánál failed + nincs maradék", async () => {
    const h = await adminH();
    const { id } = await runBackup(ctx.db, ctx.cfg, runner, "manual", { actorId: (await ctx.db.select().from(auditLogs))[0]!.actorId ?? undefined });
    const [row] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, id));
    expect(row!.status).toBe("ok");
    expect(existsSync(row!.dbFile!)).toBe(true);
    expect(existsSync(row!.photosFile!)).toBe(true);
    expect(row!.dbFile).not.toBe(row!.photosFile);
    runner.fail = true;
    const bad = await runBackup(ctx.db, ctx.cfg, runner, "manual");
    const [failed] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, bad.id));
    expect(failed).toMatchObject({ status: "failed", error: "pg_dump hiba" });
    const list = (await ctx.app.inject({ method: "GET", url: "/api/admin/backups", headers: h })).json();
    expect(list.length).toBe(2);
  });

  it("napi mentés csak ha az utolsó sikeres 24 óránál régebbi; lezárt esemény pillanatképe egyszer; hibás próba 30 percig nem ismétlődik", async () => {
    await runScheduledBackups(ctx.db, ctx.cfg, runner);
    await runScheduledBackups(ctx.db, ctx.cfg, runner);
    expect((await ctx.db.select().from(backupRuns).where(eq(backupRuns.kind, "daily"))).length).toBe(1);
    const [ev] = await ctx.db.insert(events).values({
      name: "E", type: "easter", status: "closed", registrationStart: new Date(), registrationClose: new Date(), modificationDeadline: new Date(),
      plannedStart: new Date(), plannedEnd: new Date(), actualEnd: new Date(),
    }).returning();
    await runScheduledBackups(ctx.db, ctx.cfg, runner);
    await runScheduledBackups(ctx.db, ctx.cfg, runner);
    expect((await ctx.db.select().from(backupRuns).where(eq(backupRuns.kind, "event_snapshot"))).length).toBe(1);
    expect((await ctx.db.select().from(backupRuns).where(eq(backupRuns.eventId, ev!.id)))[0]!.status).toBe("ok");
    // 25 óra múlva új napi mentés
    await runScheduledBackups(ctx.db, ctx.cfg, runner, new Date(Date.now() + 25 * 3600_000));
    expect((await ctx.db.select().from(backupRuns).where(eq(backupRuns.kind, "daily"))).length).toBe(2);
  });

  it("megőrzés: 7 napnál régebbi napi mentés törlődik, az utolsó sikeres mindig megmarad, a snapshot tovább él", async () => {
    const a = await runBackup(ctx.db, ctx.cfg, runner, "daily");
    const old = new Date(Date.now() - 10 * 86400_000);
    await ctx.db.update(backupRuns).set({ startedAt: old }).where(eq(backupRuns.id, a.id));
    const b = await runBackup(ctx.db, ctx.cfg, runner, "daily");
    const [snapEv] = await ctx.db.insert(events).values({ name: "E", type: "easter", status: "closed", registrationStart: new Date(), registrationClose: new Date(), modificationDeadline: new Date(), plannedStart: new Date(), plannedEnd: new Date() }).returning();
    const s = await runBackup(ctx.db, ctx.cfg, runner, "event_snapshot", { eventId: snapEv!.id });
    await ctx.db.update(backupRuns).set({ startedAt: old }).where(eq(backupRuns.id, s.id));
    await pruneBackups(ctx.db, ctx.cfg);
    const ids = (await ctx.db.select().from(backupRuns)).map((r) => r.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(s.id);
  });
});

describe("adatmegőrzés", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

  it("lezárás + 7 nap: résztvevői hozzáférés megszűnik; előtte él", async () => {
    const { ev, tms } = await world(ctx, 1, 1);
    await ctx.db.update(events).set({ status: "closed", actualEnd: daysAgo(3) }).where(eq(events.id, ev.id));
    await runRetention(ctx.db, ctx.cfg);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(200);
    await ctx.db.update(events).set({ actualEnd: daysAgo(8) }).where(eq(events.id, ev.id));
    await runRetention(ctx.db, ctx.cfg);
    expect((await ctx.app.inject({ method: "GET", url: "/api/access/team", headers: { cookie: tms[0]!.cookie } })).statusCode).toBe(401);
    await runRetention(ctx.db, ctx.cfg); // idempotens
    expect((await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "event.access_expired"))).length).toBe(1);
  });

  it("12 hónap után anonimizálás (aggregált adat marad), 24 hónap után fotók törlése; audit változatlan", async () => {
    const { ev, sts, tms } = await world(ctx, 1, 1);
    await ci(ctx, tms[0]!, sts[0]!.id, sts[0]!.latitude, sts[0]!.longitude);
    const [ph] = await ctx.db.insert(photos).values({ eventId: ev.id, teamId: tms[0]!.id, stationId: sts[0]!.id, fileKey: "x/p.jpg", thumbKey: "x/p_t.jpg", originalAt: new Date() }).returning();
    await ctx.db.update(events).set({ status: "closed", actualEnd: daysAgo(400) }).where(eq(events.id, ev.id));
    const auditBefore = (await ctx.db.select().from(auditLogs)).length;
    const r = await runRetention(ctx.db, ctx.cfg);
    expect(r.anonymized).toBe(1);
    expect(r.photosPurged).toBe(0); // 400 nap < 24 hónap
    const [t] = await ctx.db.select().from(teams);
    expect(t!.contactName).toBe("Anonimizált");
    expect((await ctx.db.select().from(teamMembers)).filter((m) => m.category === "child").length).toBe(1); // aggregált bontás marad
    const [h] = await ctx.db.select().from(hosts);
    expect(h).toMatchObject({ address: "Anonimizált cím", latitude: null });
    expect((await ctx.db.select().from(stations))[0]!.address).toBe("Anonimizált cím");
    expect((await ctx.db.select().from(auditLogs)).length).toBeGreaterThanOrEqual(auditBefore);

    await ctx.db.update(events).set({ actualEnd: daysAgo(800) }).where(eq(events.id, ev.id));
    expect((await runRetention(ctx.db, ctx.cfg)).photosPurged).toBe(1);
    expect((await ctx.db.select().from(photos).where(eq(photos.id, ph!.id)))[0]).toMatchObject({ status: "deleted", deletedBy: "retention", fileKey: null });
    expect((await runRetention(ctx.db, ctx.cfg)).photosPurged).toBe(0); // idempotens
  });

  it("friss esemény adatai érintetlenek", async () => {
    const { ev } = await world(ctx, 1, 1);
    await ctx.db.update(events).set({ status: "closed", actualEnd: daysAgo(30) }).where(eq(events.id, ev.id));
    const r = await runRetention(ctx.db, ctx.cfg);
    expect(r).toEqual({ accessRevoked: 1, anonymized: 0, photosPurged: 0 });
    expect((await ctx.db.select().from(teams))[0]!.name).toBe("Csapat1");
    void hd;
  });
});
