import { distanceMeters } from "../geo";

export interface RouteStation { id: string; number: number; label: string; latitude: number; longitude: number }
export interface LatLng { lat: number; lng: number }

/** A Google a waypointok számát 25-ben korlátozza (optimalizálással együtt is); ennyi + 1 célpont fér egy kérésbe. */
export const MAX_WAYPOINTS = 25;

export interface RoutePlan {
  request: {
    origin: LatLng; destination: LatLng; waypoints: Array<{ location: LatLng; stopover: true }>;
    optimizeWaypoints: true; travelMode: "WALKING" | "DRIVING";
  };
  /** A kérésbe bekerült állomások a waypoint-sorrendhez igazítva: [...waypointok, célpont]. */
  waypointStations: RouteStation[];
  destinationStation: RouteStation;
  /** Ha 26-nál több állomás maradt, a legközelebbi 26 került be. */
  truncated: boolean;
}

/**
 * Útvonalkérés a hátralévő állomásokra. A célpont az állomások utolsó eleme (szám szerint), a többi waypoint;
 * az `optimizeWaypoints` a köztes sorrendet a Google-re bízza.
 */
export function buildRoutePlan(origin: LatLng, remaining: RouteStation[], travelMode: "WALKING" | "DRIVING" = "WALKING"): RoutePlan | null {
  if (remaining.length === 0) return null;
  let list = [...remaining].sort((a, b) => a.number - b.number);
  let truncated = false;
  if (list.length > MAX_WAYPOINTS + 1) {
    truncated = true;
    list = list
      .map((s) => ({ s, d: distanceMeters(origin.lat, origin.lng, s.latitude, s.longitude) }))
      .sort((a, b) => a.d - b.d).slice(0, MAX_WAYPOINTS + 1).map((x) => x.s)
      .sort((a, b) => a.number - b.number);
  }
  const destinationStation = list[list.length - 1]!;
  const waypointStations = list.slice(0, -1);
  return {
    request: {
      origin, destination: { lat: destinationStation.latitude, lng: destinationStation.longitude },
      waypoints: waypointStations.map((s) => ({ location: { lat: s.latitude, lng: s.longitude }, stopover: true as const })),
      optimizeWaypoints: true, travelMode,
    },
    waypointStations, destinationStation, truncated,
  };
}

/** A Google `waypoint_order` (az eredeti waypoint-indexek új sorrendje) alapján a látogatási sorrend. */
export function visitOrder(plan: RoutePlan, waypointOrder: number[]): RouteStation[] {
  return [...waypointOrder.map((i) => plan.waypointStations[i]!).filter(Boolean), plan.destinationStation];
}
