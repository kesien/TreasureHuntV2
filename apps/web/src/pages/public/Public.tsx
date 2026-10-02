import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, newKey, setCsrf } from "../../api";
import { Banner, Button, ErrorText, Field, Input, Loading, Select, Textarea, useAction } from "../../components/ui";
import { EVENT_STATUS_LABEL, fmtDateTime, PICKUP_LABEL } from "../../format";
import { useFetch } from "../../hooks";
import { useAccessMe } from "../../session";

export interface PublicEvent {
  id: string; name: string; type: "halloween" | "easter"; shortDescription: string; rules: string; status: string;
  registrationStart: string; registrationClose: string; modificationDeadline: string; plannedStart: string; plannedEnd: string; organizerContact: string; locality?: string;
}

function useTheme(type?: string) {
  useEffect(() => { document.documentElement.dataset.theme = type ?? "halloween"; }, [type]);
}

export function Home() {
  const { me } = useAccessMe();
  const events = useFetch<PublicEvent[]>("/api/public/events");
  useTheme();
  return (
    <div className="page">
      <h1>Kincsvadászat</h1>
      <p className="muted">Szezonális közösségi esemény: csapatok járják a település állomásait.</p>
      {me && <Banner kind="info" title="Be vagy jelentkezve"><Link to={me.role === "team" ? "/csapat" : "/host"}>Tovább az alkalmazásba</Link></Banner>}
      {events.loading && <Loading />}
      {events.data?.length === 0 && <Banner kind="info" title="Jelenleg nincs meghirdetett esemény" />}
      {events.data?.map((e) => (
        <div className="card" key={e.id}>
          <h2 style={{ marginTop: 0 }}>{e.name}</h2>
          <p>{e.shortDescription}</p>
          <p className="muted">{fmtDateTime(e.plannedStart)} · {EVENT_STATUS_LABEL[e.status]}</p>
          <Link className="btn" to={`/esemeny/${e.id}`}>Részletek és jelentkezés</Link>
        </div>
      ))}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Már jelentkeztél?</h2>
        <p>A belépési linket e-mailben küldtük jóváhagyás után. Nyisd meg a linket, és add meg a PIN kódot.</p>
        <div className="row"><Link to="/pin-visszaallitas">Elfelejtettem a PIN-t</Link><Link to="/utmutato">Útmutató</Link></div>
      </div>
    </div>
  );
}

export function EventPage() {
  const { id } = useParams();
  const ev = useFetch<PublicEvent>(`/api/public/events/${id}`);
  useTheme(ev.data?.type);
  if (ev.loading) return <div className="page"><Loading /></div>;
  if (!ev.data) return <div className="page"><Banner kind="warn" title="Az esemény nem található vagy már lezárult" /><Link to="/">Főoldal</Link></div>;
  const e = ev.data;
  const now = Date.now();
  const open = e.status === "registration_open" && now >= new Date(e.registrationStart).getTime() && now <= new Date(e.registrationClose).getTime();
  return (
    <div className="page">
      <h1>{e.name}</h1>
      <p>{e.shortDescription}</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Időpontok</h2>
        <table className="t"><tbody>
          <tr><th>Az esemény</th><td>{fmtDateTime(e.plannedStart)} – {fmtDateTime(e.plannedEnd)}</td></tr>
          <tr><th>Jelentkezési időszak</th><td>{fmtDateTime(e.registrationStart)} – {fmtDateTime(e.registrationClose)}</td></tr>
          <tr><th>Módosítási határidő</th><td>{fmtDateTime(e.modificationDeadline)}</td></tr>
        </tbody></table>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Alapvető szabályok</h2>
        <ul>
          <li>Csapatonként legalább egy gyermek szükséges.</li>
          <li>A helyszínek az esemény előtt 24 órával jelennek meg a jóváhagyott résztvevőknek.</li>
          <li>Az állomásokon a telefon helymeghatározásával „Megérkeztünk” jelzést adtok.</li>
          <li>Becsekkolás után állomásonként legfeljebb 5 fotó tölthető fel; csak olyan fotót tölts fel, amelynek megosztására jogosult vagy.</li>
          <li>Nincs verseny, ranglista vagy díjazás.</li>
        </ul>
        {e.rules && <details><summary><b>Részletes szabályzat</b></summary><div style={{ whiteSpace: "pre-wrap" }}>{e.rules}</div></details>}
        <details><summary><b>Adatkezelési tájékoztató</b></summary>
          <p>Csak a részvételhez szükséges adatokat kezeljük: kapcsolattartó neve, e-mail, telefon; csapattagoknál név és gyermek/felnőtt kategória; házigazdáknál cím. A pontos GPS-koordinátát nem tároljuk, csak a számolt távolságot. A személyes adatokat az esemény után kb. 12 hónappal töröljük/anonimizáljuk, a fotókat legfeljebb 24 hónapig őrizzük. Kérdés vagy adatkezelési kérelem esetén: {e.organizerContact || "a szervezők"}.</p>
        </details>
      </div>
      {open ? (
        <div className="stack">
          <Link className="btn block" to={`/esemeny/${e.id}/csapat`}>Csapat jelentkezés</Link>
          <Link className="btn secondary block" to={`/esemeny/${e.id}/host`}>Házigazdaként (állomásként) jelentkezem</Link>
        </div>
      ) : <Banner kind="info" title="A jelentkezés jelenleg nem elérhető">{now < new Date(e.registrationStart).getTime() ? "A jelentkezés még nem indult el." : "A jelentkezési időszak lezárult."}</Banner>}
      {e.organizerContact && <p className="muted">Szervezői kapcsolat: {e.organizerContact}</p>}
    </div>
  );
}

function Done({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="page"><Banner kind="ok" title={title}>{children}</Banner><Link className="btn" to="/">Főoldal</Link></div>;
}

export function TeamApply() {
  const { id } = useParams();
  const ev = useFetch<PublicEvent>(`/api/public/events/${id}`);
  useTheme(ev.data?.type);
  const key = useRef(newKey()); // a beküldés idempotencia kulcsa
  const [f, setF] = useState({ name: "", contactName: "", email: "", phone: "" });
  const [members, setMembers] = useState<Array<{ name: string; category: "child" | "adult" }>>([{ name: "", category: "child" }]);
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState(false);
  const a = useAction();
  const children = members.filter((m) => m.category === "child").length;
  const valid = f.name.trim() && f.contactName.trim() && f.email && f.phone && members.every((m) => m.name.trim()) && children >= 1 && consent;

  if (done) return <Done title="Köszönjük a jelentkezést!">A jelentkezésed Függőben állapotú. Visszaigazoló e-mailt küldtünk a megadott címre. A belépési link és a PIN a jóváhagyás után érkezik.</Done>;
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => { await api(`/api/public/events/${id}/teams`, { body: { ...f, members, consent }, headers: { "Idempotency-Key": key.current } }); setDone(true); });
  }
  return (
    <form className="page" onSubmit={submit}>
      <h1>Csapat jelentkezés</h1>
      <p className="muted">{ev.data?.name}</p>
      <Field label="Csapatnév"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
      <Field label="Kapcsolattartó neve"><Input required value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} autoComplete="name" /></Field>
      <Field label="E-mail cím"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
      <Field label="Telefonszám" hint="Pl. +36 30 123 4567"><Input required type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></Field>
      <h2>Csapattagok</h2>
      <p className="muted">Legalább egy gyermek tagnak szerepelnie kell. Gyermekről csak a nevét és gyermek mivoltát kérjük.</p>
      {members.map((m, i) => (
        <div className="row" key={i} style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 2, minWidth: 140 }}><Field label={`Tag ${i + 1} neve`}><Input required value={m.name} onChange={(e) => setMembers(members.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field></div>
          <div style={{ flex: 1, minWidth: 110 }}><Field label="Kategória"><Select value={m.category} onChange={(e) => setMembers(members.map((x, j) => j === i ? { ...x, category: e.target.value as "child" | "adult" } : x))}><option value="child">Gyermek</option><option value="adult">Felnőtt</option></Select></Field></div>
          {members.length > 1 && <Button small variant="ghost" style={{ marginBottom: 12 }} aria-label={`${i + 1}. tag törlése`} onClick={() => setMembers(members.filter((_, j) => j !== i))}>🗑</Button>}
        </div>
      ))}
      <Button variant="secondary" small onClick={() => setMembers([...members, { name: "", category: "child" }])}>+ Tag hozzáadása</Button>
      <p><b>{members.length} fő</b> · {children} gyermek · {members.length - children} felnőtt</p>
      {children === 0 && <p className="error-text" role="alert">Legalább egy gyermek tag kötelező.</p>}
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Elfogadom az adatkezelési tájékoztatót és a szabályzatot, és kijelentem, hogy a megadott adatok megadására jogosult vagyok.</label>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || !valid}>{a.busy ? "Küldés…" : "Jelentkezés elküldése"}</Button>
    </form>
  );
}

export function HostApply() {
  const { id } = useParams();
  const ev = useFetch<PublicEvent>(`/api/public/events/${id}`);
  useTheme(ev.data?.type);
  const key = useRef(newKey());
  const [f, setF] = useState({ contactName: "", email: "", phone: "", address: "", pickupMode: "gift_outside", participantNote: "" });
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState(false);
  const a = useAction();
  if (done) return <Done title="Köszönjük a jelentkezést!">Az állomás-jelentkezésed Függőben állapotú. A szervezők megerősítik a címed térképes pozícióját, majd jóváhagyás után e-mailben küldjük a belépési linket és a PIN-t. A neved a csapatok számára nem látható; az állomásod „Állomás #N” néven jelenik meg.</Done>;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api(`/api/public/events/${id}/hosts`, { body: { ...f, participantNote: f.participantNote || undefined, consent }, headers: { "Idempotency-Key": key.current } }); setDone(true); }); }}>
      <h1>Házigazda (állomás) jelentkezés</h1>
      <p className="muted">{ev.data?.name}</p>
      <Field label="Kapcsolattartó neve"><Input required value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} autoComplete="name" /></Field>
      <Field label="E-mail cím"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
      <Field label="Telefonszám" hint="Pl. +36 30 123 4567"><Input required type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></Field>
      <Field label="Az állomás címe" hint="Irányítószám, település, utca, házszám"><Input required value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} minLength={5} autoComplete="street-address" /></Field>
      <Field label="Hogyan adod át az ajándékot?">
        <Select value={f.pickupMode} onChange={(e) => setF({ ...f, pickupMode: e.target.value })}>
          {Object.entries(PICKUP_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label="Megjegyzés a résztvevőknek (nem kötelező)"><Textarea value={f.participantNote} onChange={(e) => setF({ ...f, participantNote: e.target.value })} maxLength={500} /></Field>
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Elfogadom az adatkezelési tájékoztatót és a szabályzatot.</label>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || !consent}>{a.busy ? "Küldés…" : "Jelentkezés elküldése"}</Button>
    </form>
  );
}

export function Login() {
  const { token } = useParams();
  const [pin, setPin] = useState("");
  const a = useAction();
  const nav = useNavigate();
  const { refresh } = useAccessMe();
  useTheme();
  const [manual, setManual] = useState("");
  const t = token ?? manual;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
      const r = await api<{ csrfToken: string; role: "team" | "host" }>("/api/access/login", { body: { token: t, pin } });
      setCsrf(r.csrfToken); await refresh(); nav(r.role === "team" ? "/csapat" : "/host", { replace: true });
    }); }}>
      <h1>Belépés</h1>
      {!token && <Banner kind="info" title="Nyisd meg a jóváhagyó e-mailben kapott linket">Vagy másold be ide a link végén lévő kódot.</Banner>}
      {!token && <Field label="Hozzáférési kód"><Input value={manual} onChange={(e) => setManual(e.target.value.trim().split("/").pop() ?? "")} autoComplete="off" /></Field>}
      <Field label="PIN (6 számjegy)"><Input inputMode="numeric" pattern="\d{6}" maxLength={6} required type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="current-password" autoFocus /></Field>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || pin.length !== 6 || !t}>{a.busy ? "Belépés…" : "Belépés"}</Button>
      <p><Link to="/pin-visszaallitas">Elfelejtettem a PIN-t</Link></p>
    </form>
  );
}

export function PinRecoveryRequest() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction();
  if (sent) return <Done title="Ellenőrizd a postaládád">Ha van ilyen címmel jóváhagyott jelentkezés, elküldtük a PIN visszaállító linket. A link rövid ideig érvényes és egyszer használható.</Done>;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api("/api/public/pin-recovery/request", { body: { email } }); setSent(true); }); }}>
      <h1>PIN visszaállítása</h1>
      <Field label="A jelentkezéskor megadott e-mail cím"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || !email}>Link kérése</Button>
    </form>
  );
}

export function PinRecoveryComplete() {
  const { token } = useParams();
  const [pin, setPin] = useState(""); const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  if (done) return <Done title="Az új PIN beállítva">Minden korábbi bejelentkezés megszűnt. <Link to="/belepes">Belépés az új PIN-nel</Link> (a jóváhagyó e-mailben kapott linken).</Done>;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api("/api/public/pin-recovery/complete", { body: { token, pin, pinAgain: again } }); setDone(true); }); }}>
      <h1>Új PIN megadása</h1>
      <Field label="Új PIN (6 számjegy)"><Input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" /></Field>
      <Field label="Új PIN még egyszer"><Input type="password" inputMode="numeric" maxLength={6} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" /></Field>
      {pin.length === 6 && again.length === 6 && pin !== again && <p className="error-text">A két PIN nem egyezik.</p>}
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || pin.length !== 6 || pin !== again}>PIN mentése</Button>
    </form>
  );
}

export function EmailConfirm() {
  const { token } = useParams();
  const [state, setState] = useState<"working" | "ok" | "fail">("working");
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; ran.current = true;
    api("/api/public/email-change/confirm", { body: { token } }).then(() => setState("ok")).catch(() => setState("fail"));
  }, [token]);
  if (state === "working") return <div className="page"><Loading /></div>;
  return state === "ok"
    ? <Done title="Az új e-mail cím megerősítve">Mostantól erre a címre érkeznek a levelek.</Done>
    : <div className="page"><Banner kind="error" title="A link érvénytelen vagy lejárt" /><Link to="/">Főoldal</Link></div>;
}
