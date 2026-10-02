import { authenticator } from "otplib";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { inviteAdmin, beginActivation, completeActivation } from "../src/services/adminAuth.js";

export async function setup(geocoders?: import("./../src/services/geocode.js").GeocoderProvider[]) {
  const cfg = loadConfig();
  await runMigrations(cfg.DATABASE_URL);
  const { db, pool } = createDb(cfg.DATABASE_URL);
  const app = await buildApp({ cfg, db, geocoders });
  return { cfg, db, pool, app };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

// audit_logs trigger miatt TRUNCATE kell (az nem aktiválja a row-level triggert)
export async function resetDb(db: Ctx["db"]) {
  await db.execute(sql`truncate table backup_runs, data_requests, error_events, photo_reports, photos, gift_reports, gift_cycles, check_ins, geocode_cache, email_deliveries, participant_tokens, policy_consents, settings, audit_logs, rate_limit_hits, access_sessions, access_credentials, stations,
    hosts, team_members, teams, events, admin_sessions, admin_recovery_codes, admin_tokens, admins restart identity cascade`);
}

export const PASSWORD = "Correct-horse-42";

export async function createActiveAdmin(ctx: Ctx, email = "admin@example.hu") {
  const { adminId, token } = await inviteAdmin(ctx.db, null, email, "Teszt Admin");
  const { secret } = await beginActivation(ctx.db, ctx.cfg, token);
  const { recoveryCodes } = await completeActivation(ctx.db, ctx.cfg, token, PASSWORD, authenticator.generate(secret));
  return { adminId, secret, recoveryCodes, email };
}

/** Bejelentkezett admin HTTP-n keresztül; visszaadja a sütit és a CSRF tokent. */
export async function loginAdmin(ctx: Ctx, a: { email: string; secret: string }) {
  const res = await ctx.app.inject({
    method: "POST", url: "/api/admin/login",
    payload: { email: a.email, password: PASSWORD, totp: authenticator.generate(a.secret) },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { cookie, csrf: (res.json() as { csrfToken: string }).csrfToken };
}

export const eventPayload = (over: Record<string, unknown> = {}) => ({
  name: "Halloween 2026", type: "halloween",
  registrationStart: "2026-10-01T00:00:00Z", registrationClose: "2026-10-20T00:00:00Z",
  modificationDeadline: "2026-10-25T00:00:00Z", plannedStart: "2026-10-31T16:00:00Z", plannedEnd: "2026-10-31T20:00:00Z",
  ...over,
});
