import { defineConfig } from "@playwright/test";

// Az E2E teszt saját adatbázist (th_e2e) és portot használ; a szervert a teszt indítja a lefordított klienssel.
export const E2E = {
  port: 3077,
  db: "postgres://th:th@localhost:5433/th_e2e",
  adminDb: "postgres://th:th@localhost:5433/postgres",
  secret: "e2e-secret-e2e-secret-e2e-secret-123456",
};

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  expect: { timeout: 10_000 },
  use: { actionTimeout: 10_000, baseURL: `http://localhost:${E2E.port}`, trace: "retain-on-failure", locale: "hu-HU", timezoneId: "Europe/Budapest" },
  webServer: {
    command: "node ../../e2e/prepare-db.mjs && npx tsx src/server.ts",
    cwd: "../apps/server",
    url: `http://localhost:${E2E.port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: E2E.db, APP_SECRET: E2E.secret, PORT: String(E2E.port), PUBLIC_BASE_URL: `http://localhost:${E2E.port}`,
      WEB_DIST: "../web/dist", PHOTO_DIR: "./data/e2e-photos", BACKUP_DIR: "./data/e2e-backups", NODE_ENV: "development",
    },
  },
});
