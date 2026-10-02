import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { api } from "../api";

interface PublicCfg { googleMapsApiKey: string; mapId: string }

export class MapsUnavailableError extends Error {}

let cfgPromise: Promise<PublicCfg> | null = null;
let initialized = false;

/** A szerver adja a (böngészőkulcs-típusú, referrer-korlátozott) kulcsot és a map ID-t. */
function publicConfig(): Promise<PublicCfg> {
  cfgPromise ??= api<PublicCfg>("/api/public/config").catch((e) => { cfgPromise = null; throw e; });
  return cfgPromise;
}

/** Érvénytelen/korlátozott kulcsnál a Google ezt a globális függvényt hívja. */
declare global { interface Window { gm_authFailure?: () => void } }

export async function loadGoogle() {
  const cfg = await publicConfig();
  if (!cfg.googleMapsApiKey) throw new MapsUnavailableError("A térkép nincs beállítva (hiányzik a Google Maps API-kulcs a szerver konfigurációjából).");
  if (!initialized) {
    window.gm_authFailure = () => window.dispatchEvent(new Event("gm-auth-failure"));
    setOptions({ key: cfg.googleMapsApiKey, v: "weekly", language: "hu", region: "HU" });
    initialized = true;
  }
  const [maps, marker] = await Promise.all([importLibrary("maps"), importLibrary("marker")]);
  return { maps, marker, mapId: cfg.mapId };
}

export async function loadRoutes() {
  await loadGoogle();
  return importLibrary("routes");
}

export function mapsErrorText(e: unknown): string {
  if (e instanceof MapsUnavailableError) return e.message;
  return "A térkép nem tölthető be. Ellenőrizd az internetkapcsolatot, majd próbáld újra.";
}
