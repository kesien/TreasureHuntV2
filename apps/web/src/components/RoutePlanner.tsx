import { useEffect, useRef, useState } from "react";
import { Banner, Button, Loading, Sheet } from "./ui";
import { GpsError, getPosition } from "../geo";
import { loadGoogle, loadRoutes, mapsErrorText } from "../lib/google";
import { buildRoutePlan, visitOrder, type RouteStation } from "../lib/route";
import { GpsHelp } from "../pages/Guide";

interface Result { order: RouteStation[]; legs: Array<{ distance: string; duration: string }>; totalDistance: string; totalDuration: string; truncated: boolean }

/**
 * Útvonal-javaslat a hátralévő állomásokra: a telefon GPS-pozíciójától indul, a Google DirectionsService optimalizálja a
 * köztes sorrendet (gyalog). Csak javaslat: a check-in szabályokat nem érinti, a pozíció nem tárolódik és nem naplózódik.
 */
export function RoutePlanner({ remaining, onClose }: { remaining: RouteStation[]; onClose: () => void }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; text: string; gps?: GpsError["kind"] } | { kind: "ok"; result: Result }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let pos;
      try { pos = await getPosition(); } catch (e) {
        if (!cancelled) setState({ kind: "error", text: "A pozíciódat nem sikerült meghatározni, ezért nem tudunk útvonalat indítani.", gps: e instanceof GpsError ? e.kind : "unavailable" });
        return;
      }
      try {
        const plan = buildRoutePlan({ lat: pos.latitude, lng: pos.longitude }, remaining);
        if (!plan) { if (!cancelled) setState({ kind: "error", text: "Nincs hátralévő állomás." }); return; }
        const { maps, mapId } = await loadGoogle();
        const routes = await loadRoutes();
        const svc = new routes.DirectionsService();
        const res = await svc.route({ ...plan.request, travelMode: google.maps.TravelMode[plan.request.travelMode] });
        if (cancelled || !mapEl.current) return;
        const map = new maps.Map(mapEl.current, { zoom: 14, center: plan.request.origin, mapId, disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy" });
        new routes.DirectionsRenderer({ map, directions: res });
        const route = res.routes[0]!;
        const order = visitOrder(plan, route.waypoint_order);
        const legs = route.legs.map((l) => ({ distance: l.distance?.text ?? "", duration: l.duration?.text ?? "" }));
        const totalM = route.legs.reduce((s, l) => s + (l.distance?.value ?? 0), 0);
        const totalS = route.legs.reduce((s, l) => s + (l.duration?.value ?? 0), 0);
        setState({ kind: "ok", result: { order, legs, totalDistance: `${(totalM / 1000).toFixed(1)} km`, totalDuration: `${Math.round(totalS / 60)} perc`, truncated: plan.truncated } });
      } catch (e) {
        const status = (e as { code?: string }).code;
        const text = status === "ZERO_RESULTS" ? "Ehhez az állomás-készlethez a Google nem talált gyalogos útvonalat."
          : status === "OVER_QUERY_LIMIT" ? "A térképszolgáltatás átmenetileg túlterhelt. Próbáld újra később."
          : status === "REQUEST_DENIED" ? "Az útvonaltervezés nincs engedélyezve a szerveren (Directions API)."
          : mapsErrorText(e);
        if (!cancelled) setState({ kind: "error", text });
      }
    })();
    return () => { cancelled = true; };
  }, [remaining]);

  return (
    <Sheet title="Útvonal a hátralévő állomásokra" onClose={onClose}>
      {state.kind === "loading" && <Loading text="Pozíció meghatározása és útvonal számítása…" />}
      {state.kind === "error" && (
        <>
          <Banner kind="warn" title="Az útvonal nem készíthető el">{state.text}</Banner>
          {state.gps && <GpsHelp kind={state.gps} />}
        </>
      )}
      <div className="map" ref={mapEl} style={{ height: state.kind === "ok" ? 280 : 0, display: state.kind === "ok" ? "block" : "none" }} role="region" aria-label="Útvonal térkép" />
      {state.kind === "ok" && (
        <>
          <p><b>{state.result.totalDistance}</b> · kb. <b>{state.result.totalDuration}</b> gyalog (javasolt sorrend)</p>
          {state.result.truncated && <Banner kind="info">Sok állomás maradt hátra, ezért a hozzád legközelebbi 26-ra készült az útvonal.</Banner>}
          <ol>
            {state.result.order.map((s, i) => (
              <li key={s.id}><b>{s.label}</b>{state.result.legs[i] ? <span className="muted"> · {state.result.legs[i]!.distance}, {state.result.legs[i]!.duration}</span> : null}</li>
            ))}
          </ol>
          <p className="muted">Ez csak javaslat: az állomásokat tetszőleges sorrendben teljesítheted.</p>
        </>
      )}
      <Button variant="secondary" onClick={onClose}>Bezárás</Button>
    </Sheet>
  );
}
