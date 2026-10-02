import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, setCsrf } from "../../api";
import { Banner, Button, ErrorText, Field, Input, useAction } from "../../components/ui";
import { useAdminMe } from "../../session";

export function AdminLogin() {
  const [f, setF] = useState({ email: "", password: "", code: "" });
  const [recovery, setRecovery] = useState(false);
  const a = useAction();
  const nav = useNavigate();
  const { refresh } = useAdminMe();
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
      const body = recovery ? { email: f.email, password: f.password, recoveryCode: f.code } : { email: f.email, password: f.password, totp: f.code };
      const r = await api<{ csrfToken: string }>("/api/admin/login", { body });
      setCsrf(r.csrfToken); await refresh(); nav("/admin", { replace: true });
    }); }}>
      <h1>Adminisztráció – belépés</h1>
      <Field label="E-mail cím"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" /></Field>
      <Field label="Jelszó"><Input type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" /></Field>
      <Field label={recovery ? "Helyreállító kód" : "Hitelesítő alkalmazás kódja (6 számjegy)"}>
        <Input required value={f.code} onChange={(e) => setF({ ...f, code: recovery ? e.target.value : e.target.value.replace(/\D/g, "") })} inputMode={recovery ? "text" : "numeric"} maxLength={recovery ? 12 : 6} autoComplete="one-time-code" />
      </Field>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy}>{a.busy ? "Belépés…" : "Belépés"}</Button>
      <div className="row" style={{ marginTop: 12 }}>
        <Button variant="ghost" small onClick={() => { setRecovery(!recovery); setF({ ...f, code: "" }); }}>{recovery ? "Mégis hitelesítő kódot használok" : "Elvesztettem a 2FA eszközöm"}</Button>
        <Link to="/admin/jelszo-visszaallitas">Elfelejtett jelszó</Link>
      </div>
    </form>
  );
}

export function AdminActivate() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const [step, setStep] = useState<"start" | "setup" | "codes">("start");
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const a = useAction();
  const saved = useRef(false);
  if (!token) return <div className="page"><Banner kind="error" title="Hiányzó meghívó link" /></div>;
  if (step === "codes") return (
    <div className="page">
      <Banner kind="ok" title="A fiók aktív">Mentsd el ezeket az egyszer használható helyreállító kódokat biztonságos helyre. Ha elveszíted a 2FA eszközöd, ezekkel léphetsz be (minden használat auditált). Ezt a listát később nem látod újra.</Banner>
      <div className="card"><ul>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul></div>
      <label className="check"><input type="checkbox" onChange={(e) => { saved.current = e.target.checked; }} /> Elmentettem a kódokat.</label>
      <Link className="btn" to="/admin/belepes">Tovább a belépéshez</Link>
    </div>
  );
  if (step === "start") return (
    <div className="page">
      <h1>Admin fiók aktiválása</h1>
      <p>A fiókhoz erős jelszót és kétlépcsős azonosítást (2FA) kell beállítanod.</p>
      <ErrorText error={a.error} />
      <Button disabled={a.busy} onClick={() => void a.run(async () => { setSecret(await api("/api/admin/activation/begin", { body: { token } })); setStep("setup"); })}>Kezdés</Button>
    </div>
  );
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/api/admin/activation/complete", { body: { token, password: pw, totp: code } });
      setCodes(r.recoveryCodes); setStep("codes");
    }); }}>
      <h1>Jelszó és 2FA beállítása</h1>
      <div className="card">
        <p><b>1.</b> Add hozzá a fiókot egy hitelesítő alkalmazáshoz (pl. Google Authenticator, Aegis, Authy) ezzel a kulccsal:</p>
        <p><code style={{ wordBreak: "break-all", fontSize: "1.1rem" }}>{secret?.secret}</code></p>
        <p className="muted">Az alkalmazásban válaszd a „kulcs kézi megadása” lehetőséget (időalapú, 6 számjegy).</p>
      </div>
      <Field label="Jelszó" hint="Legalább 12 karakter, betűt és számot is tartalmazzon."><Input type="password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Jelszó még egyszer"><Input type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Az alkalmazás által mutatott 6 számjegyű kód"><Input required inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" /></Field>
      {pw && pw2 && pw !== pw2 && <p className="error-text">A két jelszó nem egyezik.</p>}
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || pw !== pw2 || code.length !== 6}>Aktiválás</Button>
    </form>
  );
}

export function AdminResetRequest() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction();
  if (sent) return <div className="page"><Banner kind="ok" title="Ellenőrizd a postaládád">Ha létezik ilyen fiók, elküldtük a visszaállító linket (30 percig érvényes, egyszer használható).</Banner></div>;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api("/api/admin/password-reset/request", { body: { email } }); setSent(true); }); }}>
      <h1>Jelszó visszaállítása</h1>
      <Field label="E-mail cím"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy}>Link kérése</Button>
    </form>
  );
}

export function AdminResetComplete() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  if (done) return <div className="page"><Banner kind="ok" title="Az új jelszó beállítva">Minden korábbi munkamenet megszűnt.</Banner><Link className="btn" to="/admin/belepes">Belépés</Link></div>;
  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api("/api/admin/password-reset/complete", { body: { token, password: pw } }); setDone(true); }); }}>
      <h1>Új jelszó</h1>
      <Field label="Új jelszó" hint="Legalább 12 karakter, betűt és számot is tartalmazzon."><Input type="password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Még egyszer"><Input type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
      <ErrorText error={a.error} />
      <Button type="submit" block disabled={a.busy || pw !== pw2}>Mentés</Button>
    </form>
  );
}
