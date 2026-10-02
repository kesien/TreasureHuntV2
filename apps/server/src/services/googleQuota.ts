import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

const KEY = "google_geocode_usage";
const month = (d: Date) => d.toISOString().slice(0, 7); // a Google számlázási hónapja (UTC naptári hónap)

/**
 * Egy Google geokódolási hívás lefoglalása a havi plafonból. Atomi (egy upsert), több példányon is helyes.
 * Hamis, ha a plafon elérve: ilyenkor a hívót a tartalék szolgáltatóra kell terelni.
 */
export async function reserveGoogleCall(db: Db, limit: number, now = new Date()): Promise<boolean> {
  const m = month(now);
  const fresh = JSON.stringify({ month: m, count: 1 });
  const rows = await db.execute(sql`
    insert into settings (key, value) values (${KEY}, ${fresh}::jsonb)
    on conflict (key) do update set
      value = case when settings.value->>'month' = ${m}
        then jsonb_build_object('month', ${m}::text, 'count', (settings.value->>'count')::int + 1)
        else jsonb_build_object('month', ${m}::text, 'count', 1) end,
      updated_at = now()
    where settings.value->>'month' <> ${m} or (settings.value->>'count')::int < ${limit}
    returning key`);
  return rows.rows.length > 0;
}

export async function googleUsage(db: Db, now = new Date()): Promise<{ month: string; count: number }> {
  const r = await db.execute(sql`select value from settings where key = ${KEY}`);
  const v = r.rows[0]?.value as { month: string; count: number } | undefined;
  const m = month(now);
  return v && v.month === m ? v : { month: m, count: 0 };
}
