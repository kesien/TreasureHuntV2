import { useState } from "react";
import { api } from "../../api";
import { Badge, Banner, Button, ErrorText, Field, Input, Select, Sheet, Textarea, useAction, useConfirm } from "../../components/ui";
import { EVENT_STATUS_LABEL, fmtDateTime, fromLocalInput, toLocalInput } from "../../format";
import { useToast } from "../../hooks";
import { useAdminEvent, type AdminEvent } from "./AdminLayout";

const NEXT: Record<string, Array<[string, string]>> = {
  draft: [["registration_open", "Jelentkezés megnyitása"]],
  registration_open: [["preparation", "Jelentkezés lezárása (előkészítés)"]],
  preparation: [["active", "Esemény indítása"], ["registration_open", "Jelentkezés újranyitása"]],
  active: [["closed", "Esemény befejezése"]],
};

export function Events() {
  const { events, reload, select } = useAdminEvent();
  const [edit, setEdit] = useState<AdminEvent | "new" | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const a = useAction();

  async function transition(e: AdminEvent, to: string) {
    const cancel = to === "cancelled";
    const labels: Record<string, string> = {
      active: "Az indításkor a függő jelentkezések automatikusan lejárnak (Lejárt – nem került jóváhagyásra), a résztvevők pedig értesítést kapnak. Az actual kezdési idő innentől mérvadó.",
      closed: "A befejezés után nincs új check-in, fotó és létszám-módosítás. A résztvevői hozzáférés még 7 napig él. Az eseményt nem lehet újra aktívvá tenni.",
      cancelled: "Az esemény elmarad: a résztvevők értesítést kapnak, a hozzáférési linkek azonnal érvénytelenek lesznek. Ez nem vonható vissza.",
    };
    const c = await confirm(cancel ? "Esemény lemondása" : "Állapotváltás", labels[to] ?? "Biztosan folytatod?", { reason: cancel, danger: cancel || to === "closed", confirmLabel: "Megerősítem" });
    if (!c.ok) return;
    await a.run(async () => { await api(`/api/admin/events/${e.id}/transition`, { body: { to, reason: c.reason } }); toast("Állapot módosítva."); reload(); });
  }
  async function remove(e: AdminEvent) {
    const c = await confirm("Üres draft törlése", "Az esemény véglegesen törlődik (csak akkor lehetséges, ha nem volt jelentkező).", { danger: true, confirmLabel: "Törlés" });
    if (c.ok) await a.run(async () => { await api(`/api/admin/events/${e.id}`, { method: "DELETE" }); reload(); });
  }

  return (
    <div className="stack">
      <div className="row between"><h1>Események</h1><Button onClick={() => setEdit("new")}>+ Új esemény</Button></div>
      <p className="muted">Egyszerre pontosan egy esemény lehet folyamatban. A lezárt események történeti adatként megmaradnak.</p>
      <ErrorText error={a.error} />
      {events.map((e) => (
        <div className="card" key={e.id}>
          <div className="row between"><h2 style={{ margin: 0 }}>{e.name}</h2><Badge kind={e.status === "active" ? "ok" : e.status === "cancelled" ? "danger" : "info"}>{EVENT_STATUS_LABEL[e.status]}</Badge></div>
          <p className="muted">{fmtDateTime(e.plannedStart)} – {fmtDateTime(e.plannedEnd)} · jelentkezés: {fmtDateTime(e.registrationStart)} – {fmtDateTime(e.registrationClose)} · módosítási határidő: {fmtDateTime(e.modificationDeadline)} · check-in sugár: {e.checkinRadiusM} m</p>
          {e.cancellationReason && <Banner kind="error" title="Lemondás oka">{e.cancellationReason}</Banner>}
          <div className="row">
            <Button small variant="secondary" onClick={() => select(e.id)}>Kiválasztás</Button>
            {!["closed", "cancelled"].includes(e.status) && <Button small variant="secondary" onClick={() => setEdit(e)}>Szerkesztés</Button>}
            {(NEXT[e.status] ?? []).map(([to, l]) => <Button small key={to} disabled={a.busy} onClick={() => void transition(e, to)}>{l}</Button>)}
            {!["closed", "cancelled"].includes(e.status) && <Button small variant="danger" disabled={a.busy} onClick={() => void transition(e, "cancelled")}>Lemondás</Button>}
            {e.status === "draft" && <Button small variant="ghost" onClick={() => void remove(e)}>Törlés</Button>}
          </div>
        </div>
      ))}
      {edit && <EventForm event={edit === "new" ? null : edit} onClose={(saved) => { setEdit(null); if (saved) { toast("Mentve."); reload(); } }} />}
      {dialog}
    </div>
  );
}

function EventForm({ event, onClose }: { event: AdminEvent | null; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState({
    name: event?.name ?? "", type: event?.type ?? "halloween", shortDescription: event?.shortDescription ?? "", rules: event?.rules ?? "",
    registrationStart: toLocalInput(event?.registrationStart), registrationClose: toLocalInput(event?.registrationClose), modificationDeadline: toLocalInput(event?.modificationDeadline),
    plannedStart: toLocalInput(event?.plannedStart), plannedEnd: toLocalInput(event?.plannedEnd), checkinRadiusM: event?.checkinRadiusM ?? 120, organizerContact: event?.organizerContact ?? "",
  });
  const a = useAction();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [details, setDetails] = useState<string[]>([]);
  const set = (k: string, v: string | number) => setF({ ...f, [k]: v });
  const dt = (k: keyof typeof f, label: string) => <Field label={label}><Input type="datetime-local" value={String(f[k])} onChange={(e) => set(k, e.target.value)} required /></Field>;

  async function save() {
    setDetails([]);
    await a.run(async () => {
      const body = {
        ...f, registrationStart: fromLocalInput(f.registrationStart), registrationClose: fromLocalInput(f.registrationClose), modificationDeadline: fromLocalInput(f.modificationDeadline),
        plannedStart: fromLocalInput(f.plannedStart), plannedEnd: fromLocalInput(f.plannedEnd), checkinRadiusM: Number(f.checkinRadiusM),
      };
      try {
        if (event) {
          const r = await api<{ warnings: string[] }>(`/api/admin/events/${event.id}`, { method: "PATCH", body });
          if (r.warnings.length) { setWarnings(r.warnings); return; }
        } else await api("/api/admin/events", { body });
        onClose(true);
      } catch (e) {
        const d = (e as { details?: string[] }).details;
        if (Array.isArray(d)) setDetails(d);
        throw e;
      }
    });
  }
  if (warnings.length) return (
    <Sheet title="Mentve – figyelmeztetés" onClose={() => onClose(true)}>
      <Banner kind="warn" title="A módosítás hatással lehet a résztvevőkre">{warnings.map((w) => <p key={w}>{w}</p>)}</Banner>
      <Button onClick={() => onClose(true)}>Rendben</Button>
    </Sheet>
  );
  return (
    <Sheet title={event ? "Esemény szerkesztése" : "Új esemény"} onClose={() => onClose(false)}>
      <Field label="Név"><Input value={f.name} onChange={(e) => set("name", e.target.value)} required /></Field>
      <Field label="Típus" hint="A vizuális téma automatikusan a típusból adódik."><Select value={f.type} onChange={(e) => set("type", e.target.value)}><option value="halloween">Halloween</option><option value="easter">Húsvét</option></Select></Field>
      <Field label="Rövid leírás"><Textarea value={f.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} maxLength={1000} /></Field>
      <Field label="Részletes szabályzat" hint="Jogi szöveg: indulás előtt magyar/EU adatvédelmi szakemberrel ellenőriztesd."><Textarea style={{ minHeight: 180 }} value={f.rules} onChange={(e) => set("rules", e.target.value)} /></Field>
      {dt("registrationStart", "Jelentkezés kezdete")}{dt("registrationClose", "Jelentkezés lezárása")}{dt("modificationDeadline", "Módosítási (és visszalépési) határidő")}
      {dt("plannedStart", "Tervezett kezdés")}{dt("plannedEnd", "Tervezett vége")}
      <Field label="GPS check-in sugár (méter)"><Input type="number" min={10} max={1000} value={f.checkinRadiusM} onChange={(e) => set("checkinRadiusM", e.target.value)} /></Field>
      <Field label="Szervezői kapcsolat (e-mail/telefon)"><Input value={f.organizerContact} onChange={(e) => set("organizerContact", e.target.value)} /></Field>
      {details.length > 0 && <Banner kind="error" title="Hibás dátumok">{details.map((d) => <p key={d}>{d}</p>)}</Banner>}
      <ErrorText error={a.error && !details.length ? a.error : null} />
      <div className="row"><Button disabled={a.busy} onClick={() => void save()}>Mentés</Button><Button variant="secondary" onClick={() => onClose(false)}>Mégsem</Button></div>
    </Sheet>
  );
}
