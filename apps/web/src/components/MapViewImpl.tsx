import { useEffect, useRef, useState } from "react";
import { Banner } from "./ui";
import { loadGoogle, mapsErrorText } from "../lib/google";

export interface Marker { id: string; lat: number; lon: number; label: string; cls?: string; title?: string }

const FALLBACK_CENTER = { lat: 47.4979, lng: 19.0402 };

/**
 * Google Maps alapú térkép. A markerek szám + állapotjellel (nem csak színnel) jelennek meg; a kattintás
 * InfoWindow-t nyit a címkével és „Részletek" gombbal. Húzható módban (pozíció-megerősítés) egyetlen marker húzható.
 */
export function MapView({ markers, onMarkerClick, draggable, onDrag, height, center, onUnavailable }: {
  markers: Marker[]; onMarkerClick?: (id: string) => void; draggable?: boolean; onDrag?: (lat: number, lon: number) => void; height?: string;
  /** Az esemény települése: ez a kezdőnézet, és ha nincs marker, ez marad. */
  center?: { lat: number; lon: number } | null;
  /** A térkép nem tölthető be (nincs kulcs/kapcsolat): a hívó listára válthat. */
  onUnavailable?: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const live = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const info = useRef<google.maps.InfoWindow | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef({ onMarkerClick, onDrag, onUnavailable });
  handlers.current = { onMarkerClick, onDrag, onUnavailable };
  useEffect(() => { if (error) handlers.current.onUnavailable?.(); }, [error]);
  const centerRef = useRef(center);
  centerRef.current = center;

  useEffect(() => {
    let cancelled = false;
    const authFail = () => setError("A Google térkép kulcsa érvénytelen, korlátozott erre a címre, vagy nincs engedélyezve a Maps JavaScript API.");
    window.addEventListener("gm-auth-failure", authFail);
    loadGoogle().then(({ maps, mapId }) => {
      if (cancelled || !el.current) return;
      const c = centerRef.current;
      map.current = new maps.Map(el.current, {
        center: c ? { lat: c.lat, lng: c.lon } : FALLBACK_CENTER, zoom: 14, mapId,
        // A Halloween téma sötét; a sötét séma csak vektoros map ID-val érvényesül (raster ID-nál a térkép világos marad)
        colorScheme: document.documentElement.dataset.theme === "halloween" ? google.maps.ColorScheme.DARK : google.maps.ColorScheme.LIGHT,
        disableDefaultUI: true, zoomControl: true, fullscreenControl: false, clickableIcons: false, gestureHandling: "greedy",
      });
      info.current = new maps.InfoWindow();
      setReady(true);
    }).catch((e) => { if (!cancelled) setError(mapsErrorText(e)); });
    return () => { cancelled = true; window.removeEventListener("gm-auth-failure", authFail); live.current.forEach((m) => { m.map = null; }); live.current = []; map.current = null; fitted.current = false; };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    live.current.forEach((x) => { x.map = null; });
    info.current?.close();
    live.current = markers.map((mk) => {
      const pin = document.createElement("div");
      pin.className = `pin ${mk.cls ?? ""}`;
      pin.textContent = mk.label;
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: m, position: { lat: mk.lat, lng: mk.lon }, content: pin, title: mk.title ?? mk.label, gmpDraggable: !!draggable, gmpClickable: !draggable,
      });
      if (draggable) {
        marker.addListener("dragend", () => {
          const p = marker.position;
          if (!p) return;
          const lat = typeof p.lat === "function" ? p.lat() : p.lat;
          const lng = typeof p.lng === "function" ? p.lng() : p.lng;
          handlers.current.onDrag?.(lat, lng);
        });
      } else if (handlers.current.onMarkerClick) {
        marker.addListener("click", () => {
          const box = document.createElement("div");
          const t = document.createElement("div");
          t.textContent = mk.title ?? mk.label;
          t.style.cssText = "font-weight:600;margin-bottom:6px;color:#111";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn small";
          b.textContent = "Részletek";
          b.onclick = () => { info.current?.close(); handlers.current.onMarkerClick?.(mk.id); };
          box.append(t, b);
          info.current?.setContent(box);
          info.current?.open({ map: m, anchor: marker });
        });
      }
      return marker;
    });
    if (markers.length && !fitted.current) {
      fitted.current = true;
      if (markers.length === 1) {
        m.setCenter({ lat: markers[0]!.lat, lng: markers[0]!.lon });
        m.setZoom(17);
      } else {
        const b = new google.maps.LatLngBounds();
        markers.forEach((x) => b.extend({ lat: x.lat, lng: x.lon }));
        m.fitBounds(b, 50);
        google.maps.event.addListenerOnce(m, "idle", () => { if ((m.getZoom() ?? 0) > 17) m.setZoom(17); });
      }
    }
  }, [markers, ready, draggable]);

  if (error) return <Banner kind="warn" title="A térkép nem érhető el">{error}</Banner>;
  return <div className="map" ref={el} style={height ? { height } : undefined} role="region" aria-label="Térkép" />;
}
