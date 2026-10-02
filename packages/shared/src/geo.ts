const R = 6371008.8; // Föld közepes sugara méterben

/** Haversine távolság méterben. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isWithinRadius(distanceM: number, radiusM: number): boolean {
  return distanceM <= radiusM;
}
