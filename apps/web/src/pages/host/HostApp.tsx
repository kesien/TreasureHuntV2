import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { PhotoGallery } from "../../components/Photos";
import { BrandMark, TAB_ICONS } from "../../components/Decor";
import { LocationPicker } from "../../components/LocationPicker";
import { Badge, Banner, Button, ErrorText, Field, Input, Loading, Select, Textarea, useAction, useConfirm } from "../../components/ui";
import { api, setCsrf } from "../../api";
import { fmtDateTime, fmtTime, PICKUP_LABEL } from "../../format";
import { useEventTheme, useFetch, useLive, useToast } from "../../hooks";
import { useAccessMe } from "../../session";
import { GuidePage } from "../Guide";
import { PinChange } from "../PinChange";

interface Dashboard {
  event: { name: string; status: string; plannedStart: string; plannedEnd: string };
  hostStatus: string; pickupMode: string; participantNote: string | null;
  counts: { children: number; adults: number; total: number };
  station: { id: string; number: number; label: string; address: string } | null;
  visits: Array<{ teamName: string; checkedInAt: string; total: number; children: number; adults: number }>;
  gift: { status: "has_gifts" | "depleted"; note: string | null; reportCount: number; likelyOut: boolean } | null;
}

export function HostApp() {
  const { me } = useAccessMe();
  const theme = useEventTheme(me?.eventType);
  const tabIcons = TAB_ICONS[theme];
  return (
    <>
      <Routes>
        <Route index element={<HostHome />} />
        <Route path="profil" element={<HostProfile />} />
        <Route path="utmutato" element={<GuidePage />} />
      </Routes>
      <nav className="tabbar" aria-label="Fő navigáció">
        <NavLink to="/host" end><span className="ico" aria-hidden>{tabIcons.main}</span>Állomásom</NavLink>
        <NavLink to="/host/profil"><span className="ico" aria-hidden>{tabIcons.people}</span>Adataim</NavLink>
        <NavLink to="/host/utmutato"><span className="ico" aria-hidden>{tabIcons.guide}</span>Útmutató</NavLink>
      </nav>
    </>
  );
}

function HostHome() {
  const { me } = useAccessMe();
  const d = useFetch<Dashboard>("/api/access/host/dashboard", { cacheKey: "host-dashboard" });
  const live = useLive("/api/access/stream", d.reload);
  const act = useAction();
  const toast = useToast();
  const [note, setNote] = useState("");
  const { confirm, dialog } = useConfirm();
  if (d.loading && !d.data) return <div className="page"><Loading /></div>;
  if (!d.data) return <div className="page"><Banner kind="error" title="Nem sikerült betölteni">{d.error?.message}</Banner></div>;
  const x = d.data;
  const active = x.event.status === "active";

  return (
    <>
      <header className="topbar"><span className="brand"><BrandMark type={me?.eventType} />{x.event.name}</span><span className="muted" aria-live="polite">{live ? "Élő" : "Frissítés…"}</span></header>
      <div className="page">
        {d.offline && <Banner kind="warn" title="Nincs kapcsolat">A legutóbb betöltött adatokat látod.</Banner>}
        <p className="muted">{fmtDateTime(x.event.plannedStart)} – {fmtTime(x.event.plannedEnd)} · <Badge kind="info">{({ draft: "Tervezés", registration_open: "Jelentkezés nyitva", preparation: "Előkészítés", active: "Folyamatban", closed: "Lezárva", cancelled: "Elmarad" } as Record<string, string>)[x.event.status]}</Badge></p>
        {!x.station && <Banner kind="warn" title="Nincs aktív állomásod">Az állomásod jelenleg nem szerepel az eseményben (pl. címváltozás miatt újra jóváhagyás szükséges).</Banner>}
        {x.station && (
          <div className="card">
            <h1 style={{ margin: 0 }}>{x.station.label}</h1>
            <p style={{ margin: "4px 0" }}>{x.station.address}</p>
            <p><b>{PICKUP_LABEL[x.pickupMode] ?? x.pickupMode}</b></p>
            {x.participantNote && <p className="muted">Résztvevői megjegyzés: {x.participantNote}</p>}
          </div>
        )}
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Várható létszám</h2>
          <div className="grid">
            <div className="stat"><b>{x.counts.children}</b>gyermek</div>
            <div className="stat"><b>{x.counts.adults}</b>felnőtt</div>
            <div className="stat"><b>{x.counts.total}</b>összesen</div>
          </div>
          <p className="muted">A végleges létszám a módosítási határidő után áll fel.</p>
        </div>

        {x.gift && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Ajándék</h2>
            {x.gift.likelyOut && <Banner kind="warn" title="Valószínűleg elfogyott">{x.gift.reportCount} csapat jelezte, hogy nincs több ajándék.</Banner>}
            {x.gift.status === "depleted" ? (
              <Banner kind="error" title="Elfogyottként jelölted">{x.gift.note ?? ""}</Banner>
            ) : <p><Badge kind="ok">Van ajándék</Badge></p>}
            <ErrorText error={act.error} />
            {x.station && active && x.gift.status === "has_gifts" && (
              <>
                <Field label="Megjegyzés a csapatoknak (nem kötelező)" hint="Pl. „Holnap újra lesz.”"><Textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
                <Button variant="danger" disabled={act.busy} onClick={() => void act.run(async () => {
                  const c = await confirm("Elfogyott az ajándék", "Jelölöd az állomást elfogyottként? A csapatok látják, de a becsekkolás továbbra is lehetséges.", { confirmLabel: "Elfogyott" });
                  if (!c.ok) return;
                  await api("/api/access/host/gift/depleted", { body: { stationId: x.station!.id, note: note || undefined } });
                  setNote(""); d.reload();
                })}>Elfogyott</Button>
              </>
            )}
            {x.station && active && (x.gift.status === "depleted" || x.gift.reportCount > 0) && (
              <Button disabled={act.busy} onClick={() => void act.run(async () => { await api("/api/access/host/gift/restock", { body: { stationId: x.station!.id } }); toast("Az állomás újra aktív."); d.reload(); })}>Újra feltöltöttem</Button>
            )}
            {!active && <p className="muted">Az ajándék állapota az esemény alatt módosítható.</p>}
          </div>
        )}

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Látogató csapatok ({x.visits.length})</h2>
          {x.visits.length === 0 ? <p className="muted">Még nem érkezett csapat.</p> : (
            <ul className="list">
              {x.visits.map((v, i) => (
                <li key={i}><div style={{ padding: 12 }}><b>{v.teamName}</b><br /><span className="muted">{fmtTime(v.checkedInAt)} · {v.total} fő ({v.children} gyermek, {v.adults} felnőtt)</span></div></li>
              ))}
            </ul>
          )}
        </div>
        {x.station && <div className="card"><PhotoGallery stationId={x.station.id} role="host" canUpload={false} /></div>}
      </div>
      {dialog}
    </>
  );
}

interface HostFull {
  contactName: string; email: string; phone: string; address: string; pickupMode: string; participantNote: string | null; status: string; locationConfirmed: boolean;
  event: { status: string; modificationDeadline: string }; canModify: boolean;
}

function HostProfile() {
  const [h, setH] = useState<HostFull | null>(null);
  const [f, setF] = useState({ contactName: "", phone: "", address: "", pickupMode: "ring_bell", participantNote: "" });
  const toast = useToast();
  const nav = useNavigate();
  const { refresh } = useAccessMe();
  const save = useAction(); const out = useAction(); const emailAct = useAction();
  const [newEmail, setNewEmail] = useState("");
  const { confirm, dialog } = useConfirm();
  const load = useCallback(async () => {
    const x = await api<HostFull>("/api/access/host");
    setH(x); setF({ contactName: x.contactName, phone: x.phone, address: x.address, pickupMode: x.pickupMode, participantNote: x.participantNote ?? "" });
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  if (!h) return <div className="page"><Loading /></div>;
  const editable = h.canModify;
  const pickupLocked = h.event.status === "active";

  return (
    <div className="page">
      <h1>Adataim</h1>
      <p className="muted">Módosítási határidő: {fmtDateTime(h.event.modificationDeadline)}</p>
      {!editable && <Banner kind="info" title="Az adatok már nem módosíthatók">A módosítási határidő lejárt, vagy az esemény már elindult.</Banner>}
      <div className="card">
        <Field label="Kapcsolattartó neve"><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} disabled={!editable} /></Field>
        <Field label="Telefonszám"><Input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} disabled={!editable} /></Field>
        <Field label="Cím" hint="Címváltozás után a pozíciót újra meg kell erősíteni, és az állomást újra jóvá kell hagyni."><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} disabled={!editable} /></Field>
        <Field label="Felvételi mód" hint={pickupLocked ? "Az esemény közben nem módosítható." : undefined}>
          <Select value={f.pickupMode} onChange={(e) => setF({ ...f, pickupMode: e.target.value })} disabled={!editable || pickupLocked}>
            <option value="gift_outside">Az ajándék kint van</option><option value="ring_bell">Csengetni / bejönni</option>
          </Select>
        </Field>
        <Field label="Megjegyzés a résztvevőknek"><Textarea value={f.participantNote} onChange={(e) => setF({ ...f, participantNote: e.target.value })} disabled={!editable} maxLength={500} /></Field>
        <ErrorText error={save.error} />
        {editable && <Button block disabled={save.busy} onClick={() => void save.run(async () => {
          const r = await api<{ reapprovalRequired: boolean }>("/api/access/host", { method: "PATCH", body: { contactName: f.contactName, phone: f.phone, address: f.address, pickupMode: f.pickupMode, participantNote: f.participantNote } });
          toast(r.reapprovalRequired ? "A címváltozás újra jóváhagyást igényel." : "Mentve."); await load();
        })}>Mentés</Button>}
      </div>

      {editable && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Állomás pozíciója</h2>
          {h.locationConfirmed ? <p><Badge kind="ok">Megerősítve</Badge></p> : <Banner kind="warn" title="A pozíció még nincs megerősítve">Keresd meg a címet, szükség esetén húzd a jelölőt a pontos helyre, majd erősítsd meg.</Banner>}
          <LocationPicker address={f.address} onConfirm={async (lat, lon, placeId) => { await api("/api/access/host/location", { method: "PUT", body: { lat, lon, placeId } }); await load(); }} />
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>E-mail cím</h2>
        <p>Jelenlegi: <b>{h.email}</b></p>
        {editable && <>
          <Field label="Új e-mail cím"><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></Field>
          <ErrorText error={emailAct.error} />
          <Button variant="secondary" disabled={emailAct.busy || !newEmail} onClick={() => void emailAct.run(async () => { await api("/api/access/host/email-change", { body: { email: newEmail } }); setNewEmail(""); toast("Megerősítő levelet küldtünk az új címre."); })}>Megerősítő levél küldése</Button>
        </>}
      </div>
      <PinChange />
      <div className="card">
        <Button variant="secondary" block onClick={async () => { await api("/api/access/logout", { method: "POST" }).catch(() => undefined); setCsrf(null); await refresh(); nav("/belepes"); }}>Kijelentkezés ezen az eszközön</Button>
        {editable && (<>
          <ErrorText error={out.error} />
          <Button variant="danger" block style={{ marginTop: 12 }} disabled={out.busy} onClick={() => void out.run(async () => {
            const c = await confirm("Visszalépés", "Biztosan visszalépsz? Az állomásod kikerül az eseményből, a hozzáférésed azonnal megszűnik.", { danger: true, confirmLabel: "Visszalépek" });
            if (!c.ok) return;
            await api("/api/access/host/withdraw", { body: { confirm: true } }); setCsrf(null); await refresh(); nav("/");
          })}>Visszalépés az eseményről</Button>
        </>)}
      </div>
      {dialog}
    </div>
  );
}
