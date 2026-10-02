import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { geocodeCache } from "../db/schema.js";
import { normalizeAddress } from "./applications.js";
import { hit } from "./rateLimit.js";

export interface GeoResult { lat: number; lon: number; label: string; provider: string }

/** Cserélhető geokódoló szolgáltató (spec §14, §85). */
export interface GeocoderProvider {
  name: string;
  search(address: string): Promise<GeoResult | null>;
}

/** Nominatim (OSM). A publikus szerver szabálya: azonosító User-Agent, max. 1 kérés/mp, cache. */
export class NominatimProvider implements GeocoderProvider {
  name = "nominatim";
  constructor(private baseUrl = "https://nominatim.openstreetmap.org", private userAgent = "TreasureHuntV2/0.1 (self-hosted)") {}
  async search(address: string): Promise<GeoResult | null> {
    const url = `${this.baseUrl}/search?format=jsonv2&limit=1&countrycodes=hu&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { "User-Agent": this.userAgent, "Accept-Language": "hu" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`geocoder http ${res.status}`);
    const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    const r = rows[0];
    return r ? { lat: Number(r.lat), lon: Number(r.lon), label: r.display_name, provider: this.name } : null;
  }
}

export class GeocodeError extends Error {
  constructor(public code: "rate_limited" | "unavailable", message: string) { super(message); }
}

/** Cache → globális rate limit → szolgáltatók sorban (fallback). A nem találat is cache-elődik. */
export async function geocodeAddress(db: Db, providers: GeocoderProvider[], address: string): Promise<GeoResult | null> {
  const key = normalizeAddress(address);
  const [cached] = await db.select().from(geocodeCache).where(eq(geocodeCache.queryNorm, key));
  if (cached) {
    const r = cached.result as GeoResult | { none: true };
    return "none" in r ? null : r;
  }
  if (!(await hit(db, "geocode_global", "all", 50, 60))) throw new GeocodeError("rate_limited", "Túl sok címkeresés. Próbáld újra később.");
  for (const p of providers) {
    try {
      const r = await p.search(address);
      await db.insert(geocodeCache).values({ queryNorm: key, result: r ?? { none: true } }).onConflictDoNothing();
      return r;
    } catch {
      // következő szolgáltató
    }
  }
  throw new GeocodeError("unavailable", "A címkeresés jelenleg nem elérhető. Add meg a pozíciót a térképen.");
}
