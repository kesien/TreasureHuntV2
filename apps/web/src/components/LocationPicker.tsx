import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Banner, Button, ErrorText, useAction } from "./ui";
import { MapView } from "./MapView";

/**
 * Cím → geokódolás (szerveren át, Google) → húzható marker → megerősítés. A végleges marker koordinátája lesz az állomás helye;
 * a geokódolás csak javaslat. Ha a cím nem található, kézzel is elhelyezhető.
 */
export function LocationPicker({ address, eventId, publicEventId, initial, onConfirm, confirmLabel = "Pozíció megerősítése" }: {
  address: string;
  /** Adminnál kell: az esemény településével szűkíti a keresést (résztvevőnél a munkamenetből adódik). */
  eventId?: string;
  /** Jelentkezéskor (munkamenet nélkül): a nyilvános, korlátozott geokódoló végpontot használja. */
  publicEventId?: string;
  initial?: { lat: number; lon: number } | null;
  onConfirm: (lat: number, lon: number, placeId?: string) => Promise<unknown>;
  confirmLabel?: string;
}) {
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(initial ?? null);
  const placeId = useRef<string | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [center, setCenter] = useState<{ lat: number; lon: number } | null>(null);
  const find = useAction();
  const ok = useAction();
  const [done, setDone] = useState(false);

  // Más címnél a korábbi megerősítés már nem érvényes
  useEffect(() => { setDone(false); }, [address]);

  async function search() {
    setMsg(null); setDone(false);
    await find.run(async () => {
      const url = publicEventId ? `/api/public/events/${publicEventId}/geocode` : "/api/geocode";
      const r = await api<{ found: boolean; lat?: number; lon?: number; placeId?: string | null; center?: { lat: number; lon: number } | null }>(url, { body: { address, eventId } });
      setCenter(r.center ?? null);
      placeId.current = r.placeId ?? undefined;
      if (r.found && r.lat !== undefined && r.lon !== undefined) setPos({ lat: r.lat, lon: r.lon });
      else { setMsg("A címet nem találtuk. Helyezd el a jelölőt kézzel a térképen."); setPos((p) => p ?? r.center ?? { lat: 47.4979, lon: 19.0402 }); }
    });
  }

  return (
    <div className="stack">
      <div className="row">
        <Button variant="secondary" onClick={() => void search()} disabled={find.busy || address.trim().length < 5}>{find.busy ? "Keresés…" : "🔎 Cím keresése a térképen"}</Button>
      </div>
      <ErrorText error={find.error} />
      {msg && <Banner kind="warn">{msg}</Banner>}
      {pos ? (
        <>
          <MapView markers={[{ id: "p", lat: pos.lat, lon: pos.lon, label: "📍", title: "Állomás pozíciója (húzható)" }]} draggable center={center} onDrag={(lat, lon) => { setPos({ lat, lon }); setDone(false); }} height="320px" />
          <p className="muted">Ha a jelölő nem a megfelelő helyen áll, húzd a pontos helyre (a házra).</p>
          <ErrorText error={ok.error} />
          <Button disabled={ok.busy} onClick={() => void ok.run(async () => { await onConfirm(pos.lat, pos.lon, placeId.current); setDone(true); })}>{confirmLabel}</Button>
          {done && <Banner kind="ok" title="Pozíció mentve" />}
        </>
      ) : (
        <p className="muted">Keresd meg a címet, vagy húzd a jelölőt a térképen.</p>
      )}
    </div>
  );
}
