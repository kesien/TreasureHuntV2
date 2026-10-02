export type GpsFailure = "denied" | "unavailable" | "timeout" | "unsupported";
export class GpsError extends Error {
  constructor(public kind: GpsFailure) { super(kind); }
}
export interface Position { latitude: number; longitude: number; accuracy: number }

/** Egyszeri pozíció; a koordináta csak a hívás idejéig él (nem tároljuk, nem naplózzuk). */
export function getPosition(timeoutMs = 15000): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new GpsError("unsupported"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new GpsError(e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

const R = 6371008.8;
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Navigációs handoff: a telefon alapértelmezett térkép/navigációs alkalmazása nyílik meg. */
export function navigationUrl(lat: number, lon: number): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return `https://maps.apple.com/?daddr=${lat},${lon}`;
  if (/Android/.test(ua)) return `geo:${lat},${lon}?q=${lat},${lon}`;
  return `https://www.openstreetmap.org/directions?to=${lat}%2C${lon}`;
}

export const MAX_ACCURACY_M = 100;
