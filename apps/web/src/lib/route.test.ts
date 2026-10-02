import { describe, expect, it } from "vitest";
import { buildRoutePlan, MAX_WAYPOINTS, visitOrder, type RouteStation } from "./route";

const st = (n: number, lat = 47.5 + n * 0.001, lng = 19.0): RouteStation => ({ id: `s${n}`, number: n, label: `Állomás #${n}`, latitude: lat, longitude: lng });
const origin = { lat: 47.5, lng: 19.0 };

describe("útvonalkérés", () => {
  it("nincs hátralévő állomás → nincs kérés", () => {
    expect(buildRoutePlan(origin, [])).toBeNull();
  });

  it("egy állomás: csak célpont, waypoint nélkül", () => {
    const p = buildRoutePlan(origin, [st(3)])!;
    expect(p.request.waypoints).toEqual([]);
    expect(p.destinationStation.id).toBe("s3");
  });

  it("a célpont az utolsó állomás, a többi optimalizált waypoint, gyalog", () => {
    const p = buildRoutePlan(origin, [st(5), st(2), st(9)])!;
    expect(p.request.optimizeWaypoints).toBe(true);
    expect(p.request.travelMode).toBe("WALKING");
    expect(p.request.origin).toEqual(origin);
    expect(p.destinationStation.number).toBe(9);
    expect(p.waypointStations.map((s) => s.number)).toEqual([2, 5]);
    expect(p.request.waypoints.every((w) => w.stopover)).toBe(true);
    expect(p.truncated).toBe(false);
  });

  it("a waypoint_order szerint adja a látogatási sorrendet, a célpont a végén", () => {
    const p = buildRoutePlan(origin, [st(1), st(2), st(3), st(4)])!; // waypointok: 1,2,3; cél: 4
    expect(visitOrder(p, [2, 0, 1]).map((s) => s.number)).toEqual([3, 1, 2, 4]);
  });

  it("a Google waypoint-korlátja felett a hozzád legközelebbi állomásokat tartja meg", () => {
    const many = Array.from({ length: 40 }, (_, i) => st(i + 1, 47.5 + (i + 1) * 0.001));
    const p = buildRoutePlan(origin, many)!;
    expect(p.truncated).toBe(true);
    expect(p.request.waypoints.length).toBe(MAX_WAYPOINTS);
    expect(p.waypointStations.length + 1).toBe(MAX_WAYPOINTS + 1);
    // a legközelebbi 26 (1..26) maradt
    expect(Math.max(p.destinationStation.number, ...p.waypointStations.map((s) => s.number))).toBe(26);
  });
});
