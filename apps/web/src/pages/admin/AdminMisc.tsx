import { useCallback, useState } from "react";
import { api } from "../../api";
import { Badge, Banner, Button, ErrorText, Field, Input, Loading, Select, Sheet, useAction, useConfirm } from "../../components/ui";
import { fmtDateTime, fromLocalInput, toLocalInput } from "../../format";
import { useFetch, useLive, useToast } from "../../hooks";
import { NeedEvent, type AdminEvent } from "./AdminLayout";

// ---------- Fotók ----------
interface AdminPhoto { id: string; status: string; team: string; stationNumber: number; reviewReason: string | null; thumbUrl: string; url: string; receivedAt: string; reports: Array<{ reporter: string; reason: string; text: string | null; at: string; decision: string | null }> }
const REASON_LABEL: Record<string, string> = { child_privacy: "Gyermek / adatvédelmi probléma", offensive: "Sértő / nem megfelelő tartalom", accidental: "Véletlen feltöltés", other: "Egyéb" };
const PHOTO_STATUS: Record<string, [string, "ok" | "warn" | "danger" | "info"]> = { visible: ["Látható", "ok"], hidden_reported: ["Jelentett – elrejtve", "danger"], pending_review: ["Elbírálásra vár", "warn"], rejected: ["Elutasítva", "danger"] };

export function Photos() {
  return <NeedEvent>{(e) => <PhotosFor event={e} />}</NeedEvent>;
}
function PhotosFor({ event }: { event: AdminEvent }) {
  const [filter, setFilter] = useState<"all" | "reported">("all");
  const list = useFetch<AdminPhoto[]>(`/api/admin/events/${event.id}/photos${filter === "reported" ? "?filter=reported" : ""}`);
  useLive("/api/admin/stream", list.reload);
  const [open, setOpen] = useState<AdminPhoto | null>(null);
  const a = useAction();
  const { confirm, dialog } = useConfirm();
  const decide = (p: AdminPhoto, d: "restore" | "delete") => a.run(async () => { await api(`/api/admin/photos/${p.id}/decision`, { body: { decision: d } }); setOpen(null); list.reload(); });
  async function del(p: AdminPhoto) {
    const c = await confirm("Fotó törlése", "A fotó véglegesen törlődik. A művelet naplózódik.", { danger: true, confirmLabel: "Törlés" });
    if (c.ok) await a.run(async () => { await api(`/api/admin/photos/${p.id}`, { method: "DELETE", body: {} }); setOpen(null); list.reload(); });
  }
  return (
    <div className="stack">
      <h1>Fotók</h1>
      <div className="chips"><button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Összes</button><button type="button" className="chip" aria-pressed={filter === "reported"} onClick={() => setFilter("reported")}>Jelentett</button></div>
      <ErrorText error={a.error} />
      {list.loading && <Loading />}
      <div className="gallery">
        {list.data?.map((p) => (
          <button key={p.id} type="button" className="thumb" onClick={() => setOpen(p)} aria-label={`Fotó, ${p.stationNumber}. állomás`}>
            <img src={p.thumbUrl} alt={`Fotó a(z) ${p.stationNumber}. állomásról`} loading="lazy" />
            <span className="badge" style={{ position: "absolute", left: 4, bottom: 4, background: "var(--surface)" }}>#{p.stationNumber} {p.status !== "visible" ? "⚠" : ""}</span>
          </button>
        ))}
      </div>
      {list.data?.length === 0 && <p className="muted">Nincs megjeleníthető fotó.</p>}
      {open && (
        <Sheet title={`Fotó – Állomás #${open.stationNumber}`} onClose={() => setOpen(null)}>
          <img src={open.url} alt="Feltöltött fotó" style={{ width: "100%", borderRadius: 12 }} />
          <p>Feltöltő csapat: <b>{open.team}</b> · {fmtDateTime(open.receivedAt)} · <Badge kind={PHOTO_STATUS[open.status]?.[1] ?? "info"}>{PHOTO_STATUS[open.status]?.[0] ?? open.status}</Badge></p>
          {open.reviewReason && <Banner kind="warn" title="Elbírálásra vár">Ok: {open.reviewReason}. A hozzá tartozó check-int az Ellenőrzés menüben bírálhatod el.</Banner>}
          {open.reports.map((r, i) => <Banner key={i} kind="warn" title={`Jelentés: ${REASON_LABEL[r.reason] ?? r.reason}`}>{r.reporter} · {fmtDateTime(r.at)}{r.text ? ` – ${r.text}` : ""}{r.decision ? ` (döntés: ${r.decision === "restored" ? "visszaállítva" : "törölve"})` : ""}</Banner>)}
          <div className="row">
            {open.status === "hidden_reported" && <><Button disabled={a.busy} onClick={() => void decide(open, "restore")}>Visszaállítás</Button><Button variant="danger" disabled={a.busy} onClick={() => void decide(open, "delete")}>Végleges törlés</Button></>}
            {open.status !== "hidden_reported" && <Button variant="danger" onClick={() => void del(open)}>Törlés</Button>}
          </div>
        </Sheet>
      )}
      {dialog}
    </div>
  );
}

// ---------- Ellenőrzés (offline review + manuális check-in) ----------
interface Review { id: string; team: string; stationNumber: number; stationRemoved: boolean; reason: string; originalAt: string; receivedAt: string; pendingPhotos: number }
const REVIEW_REASON: Record<string, string> = {
  station_removed: "Az állomást közben eltávolították", after_event_end: "Az esemény vége után keletkezett", before_event_start: "Az esemény kezdete előtti időbélyeg",
  clock_anomaly: "Irreális telefonóra (jövőbeli idő)", distance_mismatch: "A szerver szerint túl messze volt", inaccurate: "Pontatlan GPS",
};
export function Reviews() {
  return <NeedEvent>{(e) => <ReviewsFor event={e} />}</NeedEvent>;
}
function ReviewsFor({ event }: { event: AdminEvent }) {
  const list = useFetch<Review[]>(`/api/admin/events/${event.id}/reviews`);
  useLive("/api/admin/stream", list.reload);
  const a = useAction();
  const [manual, setManual] = useState(false);
  const { confirm, dialog } = useConfirm();
  async function decide(r: Review, decision: "accept" | "reject") {
    const c = await confirm(decision === "accept" ? "Check-in elfogadása" : "Check-in elutasítása", decision === "accept" ? "A teljesítés érvényes lesz, a hozzá tartozó fotók láthatóvá válnak." : "A teljesítés nem számít, a fotók nem jelennek meg a galériában.", { reason: true, danger: decision === "reject", confirmLabel: decision === "accept" ? "Elfogadom" : "Elutasítom" });
    if (c.ok) await a.run(async () => { await api(`/api/admin/checkins/${r.id}/review`, { body: { decision, reason: c.reason } }); list.reload(); });
  }
  return (
    <div className="stack">
      <div className="row between"><h1>Ellenőrzés</h1><Button onClick={() => setManual(true)}>+ Manuális check-in</Button></div>
      <p className="muted">Az offline szinkronból érkezett, automatikusan nem elfogadható check-inek. A teljesítés addig nem számít.</p>
      <ErrorText error={a.error} />
      {list.data?.length === 0 && <Banner kind="ok" title="Nincs elbírálásra váró tétel" />}
      {list.data?.map((r) => (
        <div className="card" key={r.id}>
          <b>{r.team}</b> → Állomás #{r.stationNumber} {r.stationRemoved && <Badge kind="danger">eltávolított állomás</Badge>}
          <p>{REVIEW_REASON[r.reason] ?? r.reason}</p>
          <p className="muted">Eredeti időbélyeg: {fmtDateTime(r.originalAt)} · szerver fogadás: {fmtDateTime(r.receivedAt)}{r.pendingPhotos > 0 ? ` · ${r.pendingPhotos} várakozó fotó` : ""}</p>
          <div className="row"><Button small onClick={() => void decide(r, "accept")}>Elfogad</Button><Button small variant="danger" onClick={() => void decide(r, "reject")}>Elutasít</Button></div>
        </div>
      ))}
      {manual && <ManualCheckIn event={event} onClose={() => { setManual(false); list.reload(); }} />}
      {dialog}
    </div>
  );
}
function ManualCheckIn({ event, onClose }: { event: AdminEvent; onClose: () => void }) {
  const teams = useFetch<Array<{ id: string; name: string; status: string }>>(`/api/admin/events/${event.id}/teams`);
  const stations = useFetch<{ stations: Array<{ id: string; number: number; status: string; address: string }> }>(`/api/admin/events/${event.id}/stations`);
  const [team, setTeam] = useState(""); const [station, setStation] = useState(""); const [at, setAt] = useState(toLocalInput(new Date())); const [reason, setReason] = useState("");
  const a = useAction();
  const toast = useToast();
  return (
    <Sheet title="Manuális check-in" onClose={onClose}>
      <Banner kind="info">Csak aktív vagy lezárt eseményhez rögzíthető. Az indoklás kötelező, a művelet naplózódik, és „admin által rögzített” jelölést kap.</Banner>
      <Field label="Csapat"><Select value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Válassz…</option>{teams.data?.filter((t) => t.status === "approved").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="Állomás"><Select value={station} onChange={(e) => setStation(e.target.value)}><option value="">Válassz…</option>{stations.data?.stations.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>#{s.number} – {s.address}</option>)}</Select></Field>
      <Field label="Időpont"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      <Field label="Indoklás (kötelező)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorText error={a.error} />
      <Button disabled={a.busy || !team || !station || !reason.trim()} onClick={() => void a.run(async () => { await api("/api/admin/checkins", { body: { teamId: team, stationId: station, at: fromLocalInput(at), reason } }); toast("Rögzítve."); onClose(); })}>Rögzítés</Button>
    </Sheet>
  );
}

// ---------- Értesítések (e-mailek) ----------
interface Delivery { id: string; type: string; recipient: string; subject: string; status: string; attempts: number; resendCount: number; lastAttemptAt: string | null; lastError: string | null; sentAt: string | null; createdAt: string }
const MAIL_STATUS: Record<string, [string, "ok" | "warn" | "danger"]> = { sent: ["Elküldve", "ok"], pending: ["Függőben / újrapróbálás alatt", "warn"], failed: ["Sikertelen", "danger"] };
export function Notifications() {
  const list = useFetch<Delivery[]>("/api/admin/emails");
  const a = useAction();
  const toast = useToast();
  return (
    <div className="stack">
      <h1>Értesítések</h1>
      <p className="muted">E-mailek állapota. Ugyanaz a címzett + típus percenként legfeljebb egyszer küldhető újra. A belépési linket/PIN-t tartalmazó levelek törzse küldés után törlődik, ezeket új hozzáférés kiadásával pótolhatod.</p>
      <ErrorText error={a.error} />
      <div className="tablewrap"><table className="t">
        <thead><tr><th>Idő</th><th>Címzett</th><th>Tárgy</th><th>Állapot</th><th></th></tr></thead>
        <tbody>
          {list.data?.map((d) => (
            <tr key={d.id}>
              <td>{fmtDateTime(d.createdAt)}</td><td>{d.recipient}</td><td>{d.subject}<br /><span className="muted">{d.type}</span></td>
              <td><Badge kind={MAIL_STATUS[d.status]?.[1] ?? "warn"}>{MAIL_STATUS[d.status]?.[0] ?? d.status}</Badge>{d.resendCount > 0 && <> <Badge kind="info">Újraküldés ×{d.resendCount}</Badge></>}<br /><span className="muted">Próbálkozás: {d.attempts}{d.lastAttemptAt ? ` · utolsó: ${fmtDateTime(d.lastAttemptAt)}` : ""}</span>{d.lastError && <><br /><span className="error-text">{d.lastError}</span></>}</td>
              <td><Button small variant="secondary" disabled={a.busy} onClick={() => void a.run(async () => { await api(`/api/admin/emails/${d.id}/resend`, { method: "POST" }); toast("Újraküldésre ütemezve."); list.reload(); })}>Újraküldés</Button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

// ---------- Audit napló ----------
interface AuditRow { id: string; at: string; actorName: string; actorType: string; action: string; entityType: string | null; entityId: string | null; reason: string | null; before: unknown; after: unknown }
export function Audit() {
  const [f, setF] = useState({ q: "", action: "", entityType: "", from: "", to: "" });
  const [page, setPage] = useState(0);
  const qs = new URLSearchParams();
  if (f.q) qs.set("q", f.q); if (f.action) qs.set("action", f.action); if (f.entityType) qs.set("entityType", f.entityType);
  if (f.from) qs.set("from", fromLocalInput(f.from + "T00:00")); if (f.to) qs.set("to", fromLocalInput(f.to + "T23:59"));
  qs.set("limit", "50"); qs.set("offset", String(page * 50));
  const data = useFetch<{ total: number; rows: AuditRow[] }>(`/api/admin/audit?${qs}`);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const set = (k: string, v: string) => { setF({ ...f, [k]: v }); setPage(0); };
  return (
    <div className="stack">
      <h1>Audit napló</h1>
      <p className="muted">A napló csak olvasható, a bejegyzések nem módosíthatók és nem törölhetők.</p>
      <div className="grid">
        <Field label="Keresés"><Input value={f.q} onChange={(e) => set("q", e.target.value)} /></Field>
        <Field label="Művelet"><Input value={f.action} onChange={(e) => set("action", e.target.value)} placeholder="pl. event.start" /></Field>
        <Field label="Entitás"><Select value={f.entityType} onChange={(e) => set("entityType", e.target.value)}><option value="">Mind</option>{["event", "team", "host", "station", "checkin", "photo", "admin", "email", "backup", "data_request"].map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Ettől"><Input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></Field>
        <Field label="Eddig"><Input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></Field>
      </div>
      <div className="tablewrap"><table className="t">
        <thead><tr><th>Idő</th><th>Ki</th><th>Művelet</th><th>Entitás</th><th>Indok</th></tr></thead>
        <tbody>
          {data.data?.rows.map((r) => (
            <tr key={r.id}><td>{fmtDateTime(r.at)}</td><td>{r.actorName}</td><td><button type="button" className="btn ghost small" onClick={() => setOpen(r)}>{r.action}</button></td><td>{r.entityType}</td><td>{r.reason}</td></tr>
          ))}
        </tbody>
      </table></div>
      <div className="row"><Button small variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Előző</Button><span>{data.data ? `${data.data.total} találat` : ""}</span><Button small variant="secondary" disabled={!data.data || (page + 1) * 50 >= data.data.total} onClick={() => setPage(page + 1)}>Következő</Button></div>
      {open && <Sheet title={open.action} onClose={() => setOpen(null)}><pre style={{ whiteSpace: "pre-wrap", overflow: "auto" }}>{JSON.stringify({ at: open.at, actor: open.actorName, entity: open.entityType, entityId: open.entityId, reason: open.reason, before: open.before, after: open.after }, null, 2)}</pre></Sheet>}
    </div>
  );
}

// ---------- Rendszerállapot + mentések ----------
interface Status { overall: "ok" | "warning" | "error"; label: string; version: string; checks: Record<string, { level: "ok" | "warning" | "error"; detail: string }> }
interface Backup { id: string; kind: string; status: string; bytes: number | null; error: string | null; startedAt: string; finishedAt: string | null }
const CHECK_LABEL: Record<string, string> = { database: "Adatbázis", storage: "Fotótároló", email: "E-mail", jobs: "Háttérfolyamatok", backup: "Mentés", errors: "Kritikus hibák" };
export function System() {
  const st = useFetch<Status>("/api/admin/system-status");
  const backups = useFetch<Backup[]>("/api/admin/backups");
  const reload = useCallback(() => { st.reload(); backups.reload(); }, [st.reload, backups.reload]);
  useLive("/api/admin/stream", reload);
  const a = useAction();
  const toast = useToast();
  const kind = (l: string) => (l === "ok" ? "ok" : l === "warning" ? "warn" : "danger") as "ok" | "warn" | "danger";
  return (
    <div className="stack">
      <h1>Rendszerállapot</h1>
      {!st.data ? <Loading /> : (
        <>
          <Banner kind={st.data.overall === "ok" ? "ok" : st.data.overall === "warning" ? "warn" : "error"} title={st.data.label}>Verzió: {st.data.version}</Banner>
          <div className="grid">{Object.entries(st.data.checks).map(([k, c]) => <div className="stat" key={k}><Badge kind={kind(c.level)}>{c.level === "ok" ? "Rendben" : c.level === "warning" ? "Figyelmeztetés" : "Hiba"}</Badge><br /><b style={{ fontSize: "1rem" }}>{CHECK_LABEL[k] ?? k}</b><span className="muted">{c.detail}</span></div>)}</div>
        </>
      )}
      <h2>Mentések</h2>
      <p className="muted">Napi automatikus mentés (legalább 7 napig megőrizve), lezáráskor külön teljes esemény-pillanatkép. Az adatbázis és a fotók külön fájlba kerülnek. A visszaállítás kézi, dokumentált folyamat (nincs „Restore” gomb).</p>
      <ErrorText error={a.error} />
      <Button disabled={a.busy} onClick={() => void a.run(async () => { await api("/api/admin/backups", { method: "POST" }); toast("A mentés elkészült."); reload(); })}>{a.busy ? "Mentés folyamatban…" : "Mentés indítása most"}</Button>
      <div className="tablewrap"><table className="t">
        <thead><tr><th>Indult</th><th>Típus</th><th>Állapot</th><th>Méret</th></tr></thead>
        <tbody>{backups.data?.map((b) => <tr key={b.id}><td>{fmtDateTime(b.startedAt)}</td><td>{({ daily: "Napi", manual: "Kézi", event_snapshot: "Esemény pillanatkép" } as Record<string, string>)[b.kind]}</td><td><Badge kind={b.status === "ok" ? "ok" : b.status === "failed" ? "danger" : "warn"}>{b.status === "ok" ? "Sikeres" : b.status === "failed" ? "Sikertelen" : "Fut"}</Badge>{b.error && <><br /><span className="error-text">{b.error}</span></>}</td><td>{b.bytes ? `${(b.bytes / 1024 / 1024).toFixed(1)} MB` : "–"}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

// ---------- Adatkezelési kérelmek ----------
interface DR { id: string; kind: string; summary: string; status: string; note: string | null; createdAt: string; resolvedAt: string | null }
export function DataRequests() {
  const list = useFetch<DR[]>("/api/admin/data-requests");
  const [kind, setKind] = useState("erasure"); const [summary, setSummary] = useState("");
  const a = useAction();
  const { confirm, dialog } = useConfirm();
  const KIND: Record<string, string> = { access: "Hozzáférés", rectification: "Helyesbítés", erasure: "Törlés", anonymization: "Anonimizálás" };
  return (
    <div className="stack">
      <h1>Adatkezelési kérelmek</h1>
      <p className="muted">Nincs önkiszolgáló portál: a beérkezett kérelmeket itt rögzítsd. Személyes adatot (nevet, e-mailt) ne írj az összefoglalóba. A törlés/anonimizálás a Csapatok és hostok oldalról kérhető. Jogszabályi folyamatok indulás előtt ellenőrizendők.</p>
      <div className="card">
        <Field label="Típus"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Rövid összefoglaló (személyes adat nélkül)"><Input value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
        <ErrorText error={a.error} />
        <Button disabled={a.busy || summary.trim().length < 3} onClick={() => void a.run(async () => { await api("/api/admin/data-requests", { body: { kind, summary } }); setSummary(""); list.reload(); })}>Rögzítés</Button>
      </div>
      {list.data?.map((r) => (
        <div className="card" key={r.id}>
          <b>{KIND[r.kind]}</b> · {fmtDateTime(r.createdAt)} · <Badge kind={r.status === "open" ? "warn" : "ok"}>{r.status === "open" ? "Nyitott" : r.status === "done" ? "Lezárva" : "Elutasítva"}</Badge>
          <p>{r.summary}</p>{r.note && <p className="muted">{r.note}</p>}
          {r.status === "open" && <div className="row"><Button small onClick={async () => { const c = await confirm("Kérelem lezárása", "Rögzíted, hogy a kérelem teljesítve lett?", {}); if (c.ok) await a.run(async () => { await api(`/api/admin/data-requests/${r.id}/resolve`, { body: { status: "done" } }); list.reload(); }); }}>Teljesítve</Button><Button small variant="secondary" onClick={async () => { const c = await confirm("Kérelem elutasítása", "Indokolt elutasítás rögzítése.", { reason: true }); if (c.ok) await a.run(async () => { await api(`/api/admin/data-requests/${r.id}/resolve`, { body: { status: "rejected", note: c.reason } }); list.reload(); }); }}>Elutasítva</Button></div>}
        </div>
      ))}
      {dialog}
    </div>
  );
}

// ---------- Adminok ----------
interface AdminRow { id: string; email: string; displayName: string; status: string }
export function Admins() {
  const list = useFetch<AdminRow[]>("/api/admin/admins");
  const [email, setEmail] = useState(""); const [name, setName] = useState("");
  const a = useAction();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const L: Record<string, [string, "ok" | "warn" | "danger"]> = { active: ["Aktív", "ok"], invited: ["Meghívva", "warn"], archived: ["Archivált", "danger"] };
  return (
    <div className="stack">
      <h1>Adminok</h1>
      <p className="muted">Minden admin azonos jogosultságú. Törlés helyett archiválás van; az archivált admin később visszaállítható, a korábbi naplóbejegyzései változatlanok maradnak.</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Új admin meghívása</h2>
        <Field label="Név"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="E-mail cím"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <ErrorText error={a.error} />
        <Button disabled={a.busy || !email || !name} onClick={() => void a.run(async () => { await api("/api/admin/admins/invite", { body: { email, displayName: name } }); setEmail(""); setName(""); toast("Meghívó elküldve (72 óráig érvényes, egyszer használható)."); list.reload(); })}>Meghívó küldése</Button>
      </div>
      <ul className="list">
        {list.data?.map((x) => (
          <li key={x.id}><div className="row between" style={{ padding: 12 }}>
            <span><b>{x.displayName}</b><br /><span className="muted">{x.email}</span></span>
            <span className="row"><Badge kind={L[x.status]?.[1] ?? "info"}>{L[x.status]?.[0] ?? x.status}</Badge>
              {x.status === "archived" ? <Button small variant="secondary" onClick={() => void a.run(async () => { await api(`/api/admin/admins/${x.id}/restore`, { method: "POST" }); list.reload(); })}>Visszaállítás</Button>
                : <Button small variant="ghost" onClick={async () => { const c = await confirm("Admin archiválása", "Az admin nem tud belépni; minden munkamenete megszűnik. Később visszaállítható.", { confirmLabel: "Archiválás" }); if (c.ok) await a.run(async () => { await api(`/api/admin/admins/${x.id}/archive`, { method: "POST" }); list.reload(); }); }}>Archiválás</Button>}
            </span></div></li>
        ))}
      </ul>
      {dialog}
    </div>
  );
}

// ---------- Beállítások (SMTP) ----------
export function Settings() {
  const cur = useFetch<{ host: string; port: number; secure: boolean; username: string; password: string; senderName: string; senderEmail: string } | null>("/api/admin/settings/smtp");
  const [f, setF] = useState({ host: "", port: 587, secure: false, username: "", password: "", senderName: "Kincsvadászat", senderEmail: "" });
  const [loaded, setLoaded] = useState(false);
  if (cur.data && !loaded) { setF({ ...cur.data }); setLoaded(true); }
  const a = useAction();
  const toast = useToast();
  return (
    <div className="stack">
      <h1>Beállítások – e-mail (SMTP)</h1>
      <p className="muted">Szabványos SMTP szerver. A jelszó titkosítva tárolódik, és sosem jelenik meg újra.</p>
      <Field label="SMTP szerver"><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>
      <Field label="Port"><Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></Field>
      <label className="check"><input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} /> Titkosított kapcsolat (SSL/TLS, tipikusan a 465-ös porton; 587-nél STARTTLS automatikus)</label>
      <Field label="Felhasználónév"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
      <Field label="Jelszó / API kulcs"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
      <Field label="Feladó neve"><Input value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></Field>
      <Field label="Feladó e-mail címe"><Input type="email" value={f.senderEmail} onChange={(e) => setF({ ...f, senderEmail: e.target.value })} /></Field>
      <ErrorText error={a.error} />
      <Button disabled={a.busy || !f.host || !f.senderEmail} onClick={() => void a.run(async () => { await api("/api/admin/settings/smtp", { method: "PUT", body: f }); toast("Mentve."); })}>Mentés</Button>
    </div>
  );
}
