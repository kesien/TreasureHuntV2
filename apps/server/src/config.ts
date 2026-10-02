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
  // Google Maps Platform. A böngészőkulcsot referrer szerint, a szerverkulcsot IP szerint korlátozd a Cloud Console-ban.
  GOOGLE_MAPS_API_KEY: z.string().default(""), // Maps JavaScript API (böngésző; publikus, a /api/public/config adja)
  GOOGLE_MAPS_MAP_ID: z.string().default("DEMO_MAP_ID"), // AdvancedMarkerElement-hez kötelező
  GOOGLE_GEOCODING_API_KEY: z.string().default(""), // Geocoding API (szerver); üres -> Nominatim
  GOOGLE_GEOCODING_MONTHLY_LIMIT: z.coerce.number().int().min(0).default(1000), // ennyi hívás/hó után Nominatim
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
