import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rateLimitHits } from "../db/schema.js";

/**
 * Adatbázis-alapú csúszóablakos limit (több példány esetén is helyes, és újraindítást is túlél).
 * Igaz, ha a kérés még engedélyezett; ilyenkor rögzíti is a próbálkozást.
 */
export async function hit(db: Db, bucket: string, key: string, max: number, windowSec: number): Promise<boolean> {
  const since = new Date(Date.now() - windowSec * 1000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rateLimitHits)
    .where(and(eq(rateLimitHits.bucket, bucket), eq(rateLimitHits.key, key), gt(rateLimitHits.at, since)));
  if ((row?.n ?? 0) >= max) return false;
  await db.insert(rateLimitHits).values({ bucket, key });
  return true;
}

/** Régi sorok takarítása (worker hívja). */
export async function purgeRateLimitHits(db: Db, olderThanSec = 86400): Promise<void> {
  await db.delete(rateLimitHits).where(sql`${rateLimitHits.at} < now() - make_interval(secs => ${olderThanSec})`);
}
