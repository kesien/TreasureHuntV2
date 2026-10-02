import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrf } from "../../api";
import { Banner, Button, ErrorText, Field, Input, Loading, Select, useAction, useConfirm } from "../../components/ui";
import { SyncBanner } from "../../components/SyncBanner";
import { fmtDateTime } from "../../format";
import { useToast } from "../../hooks";
import { useAccessMe } from "../../session";
import { PinChange } from "../PinChange";
import type { TeamInfo } from "./TeamApp";

interface TeamFull extends TeamInfo { contactName: string; email: string; pendingEmail: string | null; phone: string; members: Array<{ id: string; name: string; category: "child" | "adult" }> }

export function TeamProfile({ team, reload }: { team: TeamInfo | null; reload: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { refresh } = useAccessMe();
  const [full, setFull] = useState<TeamFull | null>(null);
  const [name, setName] = useState(""); const [contact, setContact] = useState(""); const [phone, setPhone] = useState("");
  const [members, setMembers] = useState<Array<{ name: string; category: "child" | "adult" }>>([]);
  const [newEmail, setNewEmail] = useState("");
  const save = useAction(); const emailAct = useAction(); const out = useAction();
  const { confirm, dialog } = useConfirm();

  const load = async () => {
    const t = await api<TeamFull>("/api/access/team");
    setFull(t); setName(t.name); setContact(t.contactName); setPhone(t.phone); setMembers(t.members.map((m) => ({ name: m.name, category: m.category })));
  };
  useEffect(() => { void load().catch(() => undefined); }, []);
  if (!full) return <div className="page"><Loading /></div>;
  const editable = full.canModify;
  const children = members.filter((m) => m.category === "child").length;

  async function logout() {
    await api("/api/access/logout", { method: "POST" }).catch(() => undefined);
    setCsrf(null); await refresh(); nav("/belepes");
  }

  return (
    <div className="page">
      <h1>Csapat</h1>
      <SyncBanner />
      <p className="muted">{full.event.name} · módosítási határidő: {fmtDateTime(full.event.modificationDeadline)}</p>
      {!editable && <Banner kind="info" title="Az adatok már nem módosíthatók">A módosítási határidő lejárt, vagy az esemény már elindult.</Banner>}
      <div className="card">
        <p><b>{full.counts.total} fő</b> · {full.counts.children} gyermek · {full.counts.adults} felnőtt</p>
        <Field label="Csapatnév"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} /></Field>
        <Field label="Kapcsolattartó neve"><Input value={contact} onChange={(e) => setContact(e.target.value)} disabled={!editable} /></Field>
        <Field label="Telefonszám"><Input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!editable} inputMode="tel" /></Field>
        <h3>Tagok</h3>
        {members.map((m, i) => (
          <div className="row" key={i} style={{ alignItems: "flex-end" }}>
            <div style={{ flex: 2, minWidth: 140 }}><Field label={`Tag ${i + 1} neve`}><Input value={m.name} disabled={!editable} onChange={(e) => setMembers(members.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field></div>
            <div style={{ flex: 1, minWidth: 110 }}>
              <Field label="Kategória"><Select value={m.category} disabled={!editable} onChange={(e) => setMembers(members.map((x, j) => j === i ? { ...x, category: e.target.value as "child" | "adult" } : x))}><option value="child">Gyermek</option><option value="adult">Felnőtt</option></Select></Field>
            </div>
            {editable && members.length > 1 && <Button small variant="ghost" style={{ marginBottom: 12 }} aria-label={`${i + 1}. tag törlése`} onClick={() => setMembers(members.filter((_, j) => j !== i))}>🗑</Button>}
          </div>
        ))}
        {editable && <Button variant="secondary" small onClick={() => setMembers([...members, { name: "", category: "child" }])}>+ Tag hozzáadása</Button>}
        {editable && children === 0 && <p className="error-text">Legalább egy gyermek tagnak szerepelnie kell.</p>}
        <ErrorText error={save.error} />
        {editable && (
          <Button block disabled={save.busy || children === 0 || members.some((m) => !m.name.trim())} onClick={() => void save.run(async () => {
            await api("/api/access/team", { method: "PATCH", body: { name, contactName: contact, phone, members } });
            toast("Mentve."); await load(); reload();
          })}>Mentés</Button>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>E-mail cím</h2>
        <p>Jelenlegi: <b>{full.email}</b></p>
        {full.pendingEmail && <Banner kind="info" title="Megerősítésre vár">A(z) {full.pendingEmail} címre megerősítő levelet küldtünk. Addig a régi cím marad érvényes.</Banner>}
        {editable && (
          <>
            <Field label="Új e-mail cím"><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" /></Field>
            <ErrorText error={emailAct.error} />
            <Button variant="secondary" disabled={emailAct.busy || !newEmail} onClick={() => void emailAct.run(async () => { await api("/api/access/team/email-change", { body: { email: newEmail } }); setNewEmail(""); toast("Megerősítő levelet küldtünk az új címre."); await load(); })}>Megerősítő levél küldése</Button>
          </>
        )}
      </div>

      <PinChange />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Kijelentkezés és visszalépés</h2>
        <Button variant="secondary" block onClick={() => void logout()}>Kijelentkezés ezen az eszközön</Button>
        <p className="muted">A kijelentkezés csak ezt a telefont érinti; a többi eszköz bejelentkezve marad.</p>
        {editable && (
          <>
            <ErrorText error={out.error} />
            <Button variant="danger" block disabled={out.busy} onClick={() => void out.run(async () => {
              const c = await confirm("Visszalépés", "Biztosan visszalépsz az eseményről? A hozzáférésed azonnal megszűnik, ez nem vonható vissza.", { danger: true, confirmLabel: "Visszalépek" });
              if (!c.ok) return;
              await api("/api/access/team/withdraw", { body: { confirm: true } });
              setCsrf(null); await refresh(); nav("/");
            })}>Visszalépés az eseményről</Button>
          </>
        )}
      </div>
      {dialog}
    </div>
  );
}
