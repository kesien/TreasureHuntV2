import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { useFetch } from "../hooks";

export interface Marker { id: string; lat: number; lon: number; label: string; cls?: string; title?: string }
interface Cfg { tileUrl: string; tileAttribution: string }

/**
 * MapLibre alapú térkép. A csempeszolgáltató a szerver /api/public/config végpontjáról jön (cserélhető),
 * az attribúció mindig látszik. A markereknek szám + állapotjel is van (nem csak szín).
 */
export function MapView({ markers, onMarkerClick, draggable, onDrag, height, center }: {
  markers: Marker[]; onMarkerClick?: (id: string) => void; draggable?: boolean; onDrag?: (lat: number, lon: number) => void; height?: string;
  /** Az esemény települése: ez a kezdőnézet, és ha nincs marker, ez marad. */
  center?: { lat: number; lon: number } | null;
}) {
  const cfg = useFetch<Cfg>("/api/public/config", { cacheKey: "map-config" });
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const live = useRef<maplibregl.Marker[]>([]);
  const fitted = useRef(false);
  const handlers = useRef({ onMarkerClick, onDrag });
  handlers.current = { onMarkerClick, onDrag };

  useEffect(() => {
    if (!cfg.data || !el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: {
        version: 8,
        sources: { base: { type: "raster", tiles: [cfg.data.tileUrl.replace("{s}", "a")], tileSize: 256, attribution: cfg.data.tileAttribution, maxzoom: 19 } },
        layers: [{ id: "base", type: "raster", source: "base" }],
      },
      center: [center?.lon ?? 19.0402, center?.lat ?? 47.4979],
      zoom: 14,
      attributionControl: { compact: false },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.current = m;
    m.once("load", () => { /* a markerek effect-je újrafuttatásához */ el.current?.dispatchEvent(new Event("map-ready")); });
    return () => { m.remove(); map.current = null; fitted.current = false; };
  }, [cfg.data]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    live.current.forEach((x) => x.remove());
    live.current = markers.map((mk) => {
      const e = document.createElement("button");
      e.type = "button";
      e.className = `pin ${mk.cls ?? ""}`;
      e.textContent = mk.label;
      e.setAttribute("aria-label", mk.title ?? mk.label);
      e.onclick = () => handlers.current.onMarkerClick?.(mk.id);
      const marker = new maplibregl.Marker({ element: e, draggable: !!draggable }).setLngLat([mk.lon, mk.lat]).addTo(m);
      if (draggable) marker.on("dragend", () => { const p = marker.getLngLat(); handlers.current.onDrag?.(p.lat, p.lng); });
      return marker;
    });
    if (markers.length && !fitted.current) {
      const b = new maplibregl.LngLatBounds();
      markers.forEach((x) => b.extend([x.lon, x.lat]));
      m.fitBounds(b, { padding: 50, maxZoom: 17, duration: 0 });
      fitted.current = true;
    }
  }, [markers, cfg.data, draggable]);

  return <div className="map" ref={el} style={height ? { height } : undefined} role="region" aria-label="Térkép" />;
}
