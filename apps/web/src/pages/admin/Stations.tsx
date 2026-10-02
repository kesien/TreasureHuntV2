import { useCallback, useState } from "react";
import { api } from "../../api";
import { Badge, Banner, Button, ErrorText, Field, Input, Select, Sheet, Textarea, useAction, useConfirm } from "../../components/ui";
import { LocationPicker } from "../../components/LocationPicker";
import { MapView, type Marker } from "../../components/MapView";
import { fmtDateTime, PICKUP_LABEL } from "../../format";
import { useFetch, useLive, useToast } from "../../hooks";
import { NeedEvent, type AdminEvent } from "./AdminLayout";

interface Station { id: string; number: number; address: string; latitude: number; longitude: number; hostId: string | null; pickupMode: string; participantNote: string | null; status: string; removedReason: string | null }
interface GiftInfo { current: { status: string; note: string | null; reports: number; likelyOut: boolean }; history: Array<{ seq: number; status: string; note: string | null; startedAt: string; reports: Array<{ team: string; at: string }> }> }

export function Stations() {
  return <NeedEvent>{(e) => <StationsFor event={e} />}</NeedEvent>;
}

function StationsFor({ event }: { event: AdminEvent }) {
  const list = useFetch<{ required: number; stations: Station[] }>(`/api/admin/events/${event.id}/stations`);
  const reload = useCallback(() => list.reload(), [list.reload]);
  useLive("/api/admin/stream", reload);
  const [creating, setCreating] = useState(false);
  const [gift, setGift] = useState<Station | null>(null);
  const { confirm, dialog } = useConfirm();
  const act = useAction();
  const toast = useToast();
  const stations = list.data?.stations ?? [];
  const markers: Marker[] = stations.filter((s) => s.status === "active").map((s) => ({ id: s.id, lat: s.latitude, lon: s.longitude, label: String(s.number), title: `Állomás #${s.number}` }));

  async function remove(s: Station) {
    const c = await confirm(`Állomás #${s.number} eltávolítása`, "Az elvárt állomásszám azonnal csökken, a résztvevők és hostok értesítést kapnak, a számozás nem változik. A korábbi check-inek története megmarad.", { reason: true, danger: true, confirmLabel: "Eltávolítás" });
    if (c.ok) await act.run(async () => { await api(`/api/admin/stations/${s.id}`, { method: "DELETE", body: { reason: c.reason } }); toast("Eltávolítva."); reload(); });
  }

  return (
    <div className="stack">
      <div className="row between"><h1>Állomások</h1><Button onClick={() => setCreating(true)}>+ Állomás host nélkül</Button></div>
      <p className="muted">Elvárt (aktív) állomások száma: <b>{list.data?.required ?? 0}</b>. {event.status === "active" && "Aktív esemény közben hozzáadott állomás minden csapatnak új kötelező feladat."}</p>
      <ErrorText error={act.error} />
      {markers.length > 0 && <MapView markers={markers} />}
      <div className="tablewrap"><table className="t">
        <thead><tr><th>#</th><th>Cím</th><th>Típus</th><th>Állapot</th><th>Műveletek</th></tr></thead>
        <tbody>
          {stations.map((s) => (
            <tr key={s.id}>
              <td><b>{s.number}</b></td>
              <td>{s.address}<br /><span className="muted">{PICKUP_LABEL[s.pickupMode]}</span></td>
              <td>{s.hostId ? "Host állomás" : <Badge kind="info">Virtuális</Badge>}</td>
              <td>{s.status === "active" ? <Badge kind="ok">Aktív</Badge> : <><Badge kind="danger">Eltávolítva</Badge><br /><span className="muted">{s.removedReason}</span></>}</td>
              <td><div className="row">
                {s.status === "active" && <><Button small variant="secondary" onClick={() => setGift(s)}>Ajándék</Button><Button small variant="ghost" onClick={() => void remove(s)}>Eltávolít</Button></>}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {creating && <CreateStation eventId={event.id} onClose={(ok) => { setCreating(false); if (ok) reload(); }} />}
      {gift && <GiftSheet station={gift} onClose={() => setGift(null)} />}
      {dialog}
    </div>
  );
}

function CreateStation({ eventId, onClose }: { eventId: string; onClose: (ok: boolean) => void }) {
  const [address, setAddress] = useState(""); const [mode, setMode] = useState("gift_outside"); const [note, setNote] = useState("");
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const a = useAction();
  const toast = useToast();
  return (
    <Sheet title="Állomás létrehozása (host nélkül)" onClose={() => onClose(false)}>
      <Field label="Cím"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      <LocationPicker address={address} confirmLabel="Pozíció megerősítése" onConfirm={async (lat, lon) => setPos({ lat, lon })} />
      <Field label="Felvételi mód"><Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="gift_outside">Az ajándék kint van</option><option value="ring_bell">Csengetni / bejönni</option></Select></Field>
      <Field label="Résztvevői megjegyzés"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      <ErrorText error={a.error} />
      <Button disabled={a.busy || !pos || address.trim().length < 3} onClick={() => void a.run(async () => {
        const r = await api<{ station: { number: number }; duplicateWarnings: Array<{ stationNumber: number; distanceM: number }> }>(`/api/admin/events/${eventId}/stations`, {
          body: { address, lat: pos!.lat, lon: pos!.lon, pickupMode: mode, participantNote: note || undefined, confirmed: true },
        });
        toast(`Létrehozva: Állomás #${r.station.number}${r.duplicateWarnings.length ? ` – figyelem: ${r.duplicateWarnings.length} közeli állomás van` : ""}`);
        onClose(true);
      })}>Létrehozás</Button>
      {!pos && <p className="muted">Előbb erősítsd meg a pozíciót.</p>}
    </Sheet>
  );
}

function GiftSheet({ station, onClose }: { station: Station; onClose: () => void }) {
  const info = useFetch<GiftInfo>(`/api/admin/stations/${station.id}/gifts`);
  const [reason, setReason] = useState(""); const [note, setNote] = useState("");
  const a = useAction();
  const g = info.data;
  return (
    <Sheet title={`Állomás #${station.number} – ajándék`} onClose={onClose}>
      {g && (
        <>
          <p>Jelenlegi állapot: <Badge kind={g.current.status === "depleted" ? "danger" : "ok"}>{g.current.status === "depleted" ? "Elfogyott" : "Van ajándék"}</Badge> · jelzések az aktuális ciklusban: <b>{g.current.reports}</b>{g.current.likelyOut && " (valószínűleg elfogyott)"}</p>
          <h3>Előzmények</h3>
          {g.history.map((h) => (
            <div className="card" key={h.seq}>
              <b>{h.seq}. ciklus</b> · {fmtDateTime(h.startedAt)} · {h.status === "depleted" ? "elfogyott" : "aktív"}{h.note && ` – ${h.note}`}
              {h.reports.length ? <ul>{h.reports.map((r, i) => <li key={i}>{r.team} – {fmtDateTime(r.at)}</li>)}</ul> : <p className="muted">Nincs jelzés.</p>}
            </div>
          ))}
          <h3>Kézi módosítás</h3>
          <Banner kind="info">A kézi módosítás indoklása kötelező, és naplózódik.</Banner>
          <Field label="Indoklás"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Field label="Megjegyzés a csapatoknak (elfogyott esetén)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <ErrorText error={a.error} />
          <div className="row">
            <Button variant="danger" disabled={a.busy || !reason.trim() || g.current.status === "depleted"} onClick={() => void a.run(async () => { await api(`/api/admin/stations/${station.id}/gifts`, { body: { action: "depleted", reason, note: note || undefined } }); info.reload(); })}>Elfogyottra állít</Button>
            <Button disabled={a.busy || !reason.trim()} onClick={() => void a.run(async () => { await api(`/api/admin/stations/${station.id}/gifts`, { body: { action: "restock", reason } }); info.reload(); })}>Újra feltöltve (új ciklus)</Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
