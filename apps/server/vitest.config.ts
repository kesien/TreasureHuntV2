import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // az integrációs tesztek közös adatbázist használnak
    testTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://th:th@localhost:5433/th_test",
      APP_SECRET: "test-secret-test-secret-test-secret-1234",
      PHOTO_DIR: "./data/test-photos",
      BACKUP_DIR: "./data/test-backups",
    },
  },
});
