import { Writable } from "node:stream";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { REDACT_PATHS, redactUrl } from "../src/logger.js";
import { runMigrations } from "../src/db/migrate.js";

describe("naplózás", () => {
  it("redactUrl kitakarja a tokeneket", () => {
    expect(redactUrl("/belepes/SECRET123")).toBe("/belepes/[REDACTED]");
    expect(redactUrl("/pin-visszaallitas/abc")).toBe("/pin-visszaallitas/[REDACTED]");
    expect(redactUrl("/email-megerosites/abc")).toBe("/email-megerosites/[REDACTED]");
    expect(redactUrl("/admin/activate?token=XYZ&a=1")).toBe("/admin/activate?token=[REDACTED]&a=1");
    expect(redactUrl("/api/health")).toBe("/api/health");
  });

  let lines = "";
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const cfg = loadConfig();
    await runMigrations(cfg.DATABASE_URL);
    const { db, pool } = createDb(cfg.DATABASE_URL);
    const stream = new Writable({ write(chunk, _e, cb) { lines += String(chunk); cb(); } });
    const logger = pino({ level: "info", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
    app = await buildApp({ cfg, db, geocoders: [], logger });
    close = async () => { await app.close(); await pool.end(); };
  });
  afterAll(async () => { await close(); });

  it("a belépési token, a PIN és a jelszó nem kerül a naplóba (sikeres és hibás kérésnél sem)", async () => {
    await app.inject({ method: "GET", url: "/belepes/SUPERSECRETTOKEN123" });
    await app.inject({ method: "POST", url: "/api/access/login", payload: { token: "T".repeat(40), pin: "987654" } });
    await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "x@example.hu", password: "Titkos-jelszo-99", totp: "123456" } });
    await app.inject({ method: "GET", url: "/admin/activate?token=ACTIVATIONSECRET" });
    expect(lines).toContain("request");
    for (const secret of ["SUPERSECRETTOKEN123", "987654", "Titkos-jelszo-99", "ACTIVATIONSECRET", "T".repeat(40)]) {
      expect(lines).not.toContain(secret);
    }
  });
});
