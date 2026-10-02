import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

export async function runMigrations(databaseUrl: string, folder = "./drizzle") {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("migrate.ts")) {
  const cfg = loadConfig();
  await runMigrations(cfg.DATABASE_URL);
  console.log("Migráció kész.");
}
