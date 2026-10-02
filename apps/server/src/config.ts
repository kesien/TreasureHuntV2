import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32),
  PHOTO_DIR: z.string().default("./data/photos"),
  BACKUP_DIR: z.string().default("./data/backups"),
  BACKUP_DAILY_RETENTION_DAYS: z.coerce.number().int().min(7).default(7),
  BACKUP_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(30).default(730),
  TILE_URL: z.string().default("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
  TILE_ATTRIBUTION: z.string().default("© OpenStreetMap közreműködők"),
  WEB_DIST: z.string().default("../web/dist"),
  APP_VERSION: z.string().default("0.1.0"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.APP_SECRET.startsWith("change-me")) {
    throw new Error("APP_SECRET nincs beállítva éles környezetben.");
  }
  return cfg;
}
