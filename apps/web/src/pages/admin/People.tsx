import { useCallback, useState } from "react";
import { api } from "../../api";
import { Badge, Banner, Button, ErrorText, Field, Input, Loading, Sheet, useAction, useConfirm } from "../../components/ui";
import { LocationPicker } from "../../components/LocationPicker";
import { fmtDateTime, PARTICIPANT_STATUS_LABEL, PICKUP_LABEL } from "../../format";
import { useFetch, useLive, useToast } from "../../hooks";
import { NeedEvent, type AdminEvent } from "./AdminLayout";

interface Team { id: string; name: string; contactName: string; email: string; phone: string; status: string; statusReason: string | null; children: number; adults: number; createdAt: string }
interface Host { id: string; contactName: string; email: string; phone: string; address: string; pickupMode: string; participantNote: string | null; status: string; statusReason: string | null; locationConfirmed: boolean; latitude: number | null; longitude: number | null; createdAt: string }

const kindOf = (s: string) => (s === "approved" ? "ok" : s === "pending" ? "warn" : s === "rejected" || s === "removed" ? "danger" : "info") as "ok" | "warn" | "danger" | "info";

export function People() {
  return <NeedEvent>{(e) => <PeopleFor event={e} />}</NeedEvent>;
}

function PeopleFor({ event }: { event: AdminEvent }) {
  const [tab, setTab] = useState<"teams" | "hosts">("teams");
  const teams = useFetch<Team[]>(`/api/admin/events/${event.id}/teams`);
  const hosts = useFetch<Host[]>(`/api/admin/events/${event.id}/hosts`);
  const reload = useCallback(() => { teams.reload(); hosts.reload(); }, [teams.reload, hosts.reload]);
  useLive("/api/admin/stream", reload);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const act = useAction();
  const [pick, setPick] = useState<Host | null>(null);
  const [view, setView] = useState<{ kind: "team" | "host"; data: unknown } | null>(null);
  const [edit, setEdit] = useState<Team | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function approve(kind: "team" | "host", id: string) {
    await act.run(async () => {
      const r = await api<{ warnings: string[] }>(`/api/admin/${kind}s/${id}/approve`, { method: "POST" });
      toast(r.warnings[0] ?? "Jóváhagyva, a hozzáférést e-mailben elküldtük.");
      reload();
    });
  }
  async function reject(kind: "team" | "host", id: string) {
    const c = await confirm("Elutasítás", "Az elutasításról a jelentkező e-mailben értesül az indoklással együtt.", { reason: true, danger: true, confirmLabel: "Elutasítás" });
    if (c.ok) await act.run(async () => { await api(`/api/admin/${kind}s/${id}/reject`, { body: { reason: c.reason } }); reload(); });
  }
  async function remove(kind: "team" | "host", id: string) {
    const c = await confirm("Eltávolítás az eseményből", "A hozzáférés azonnal megszűnik, a történeti adatok megmaradnak.", { reason: true, danger: true, confirmLabel: "Eltávolítás" });
    if (c.ok) await act.run(async () => { await api(`/api/admin/${kind}s/${id}/remove`, { body: { reason: c.reason } }); reload(); });
  }
  async function reissue(kind: "team" | "host", id: string) {
    const c = await confirm("Új hozzáférés kiadása", "Új link és új PIN készül és megy e-mailben; a régi hozzáférés és minden munkamenet megszűnik.", { confirmLabel: "Kiadás" });
    if (c.ok) await act.run(async () => { await api(`/api/admin/${kind}s/${id}/reissue-access`, { method: "POST" }); toast("Elküldve."); });
  }
  async function regenLink(kind: "team" | "host", id: string) {
    const c = await confirm("Új hozzáférési link", "A régi link azonnal érvénytelen lesz; a PIN és a már bejelentkezett eszközök nem változnak. Az új link csak most látható.", { confirmLabel: "Új link készítése" });
    if (!c.ok) return;
    await act.run(async () => { const r = await api<{ link: string }>(`/api/admin/${kind}s/${id}/regenerate-link`, { method: "POST" }); setLink(r.link); });
  }
  async function viewAs(kind: "team" | "host", id: string) {
    await act.run(async () => setView({ kind, data: await api(`/api/admin/view-as/${kind}/${id}`) }));
  }

  return (
    <div className="stack">
      <h1>Csapatok és hostok</h1>
      <div className="chips"><button type="button" className="chip" aria-pressed={tab === "teams"} onClick={() => setTab("teams")}>Csapatok ({teams.data?.length ?? 0})</button><button type="button" className="chip" aria-pressed={tab === "hosts"} onClick={() => setTab("hosts")}>Hostok ({hosts.data?.length ?? 0})</button></div>
      <ErrorText error={act.error} />
      {(teams.loading || hosts.loading) && <Loading />}
      {tab === "teams" && (
        <div className="tablewrap"><table className="t">
          <thead><tr><th>Csapat</th><th>Kapcsolattartó</th><th>Létszám</th><th>Állapot</th><th>Műveletek</th></tr></thead>
          <tbody>
            {teams.data?.map((t) => (
              <tr key={t.id}>
                <td><b>{t.name}</b><br /><span className="muted">{fmtDateTime(t.createdAt)}</span></td>
                <td>{t.contactName}<br />{t.email}<br />{t.phone}</td>
                <td>{t.children + t.adults} ({t.children} gy., {t.adults} f.)</td>
                <td><Badge kind={kindOf(t.status)}>{PARTICIPANT_STATUS_LABEL[t.status]}</Badge>{t.statusReason && <><br /><span className="muted">{t.statusReason}</span></>}</td>
                <td><div className="row">
                  {t.status === "pending" && <><Button small onClick={() => void approve("team", t.id)} disabled={act.busy}>Jóváhagy</Button><Button small variant="danger" onClick={() => void reject("team", t.id)}>Elutasít</Button></>}
                  {t.status === "approved" && <><Button small variant="secondary" onClick={() => void viewAs("team", t.id)}>Megtekintés csapatként</Button><Button small variant="secondary" onClick={() => void reissue("team", t.id)}>Új hozzáférés</Button><Button small variant="secondary" onClick={() => void regenLink("team", t.id)}>Új link</Button></>}
                  {["pending", "approved"].includes(t.status) && <><Button small variant="secondary" onClick={() => setEdit(t)}>Szerkesztés</Button><Button small variant="ghost" onClick={() => void remove("team", t.id)}>Eltávolít</Button></>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {tab === "hosts" && (
        <div className="tablewrap"><table className="t">
          <thead><tr><th>Cím</th><th>Kapcsolattartó</th><th>Mód</th><th>Állapot</th><th>Műveletek</th></tr></thead>
          <tbody>
            {hosts.data?.map((h) => (
              <tr key={h.id}>
                <td><b>{h.address}</b><br />{h.locationConfirmed ? <Badge kind="ok">Pozíció megerősítve</Badge> : <Badge kind="warn">Pozíció nincs megerősítve</Badge>}</td>
                <td>{h.contactName}<br />{h.email}<br />{h.phone}</td>
                <td>{PICKUP_LABEL[h.pickupMode]}{h.participantNote && <><br /><span className="muted">{h.participantNote}</span></>}</td>
                <td><Badge kind={kindOf(h.status)}>{PARTICIPANT_STATUS_LABEL[h.status]}</Badge>{h.statusReason && <><br /><span className="muted">{h.statusReason}</span></>}</td>
                <td><div className="row">
                  {["pending", "approved"].includes(h.status) && <Button small variant="secondary" onClick={() => setPick(h)}>Pozíció</Button>}
                  {h.status === "pending" && <><Button small onClick={() => void approve("host", h.id)} disabled={act.busy || !h.locationConfirmed} title={h.locationConfirmed ? undefined : "Előbb erősítsd meg a pozíciót"}>Jóváhagy</Button><Button small variant="danger" onClick={() => void reject("host", h.id)}>Elutasít</Button></>}
                  {h.status === "approved" && <><Button small variant="secondary" onClick={() => void viewAs("host", h.id)}>Megtekintés hostként</Button><Button small variant="secondary" onClick={() => void reissue("host", h.id)}>Új hozzáférés</Button><Button small variant="secondary" onClick={() => void regenLink("host", h.id)}>Új link</Button></>}
                  {["pending", "approved"].includes(h.status) && <Button small variant="ghost" onClick={() => void remove("host", h.id)}>Eltávolít</Button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {pick && (
        <Sheet title="Állomás pozíciója" onClose={() => { setPick(null); reload(); }}>
          <p><b>{pick.address}</b></p>
          <p className="muted">Keresd meg a címet, szükség esetén húzd a jelölőt a pontos helyre, majd erősítsd meg. A host neve a csapatoknak sosem látszik.</p>
          <LocationPicker address={pick.address} eventId={event.id} initial={pick.latitude != null && pick.longitude != null ? { lat: pick.latitude, lon: pick.longitude } : null}
            onConfirm={async (lat, lon) => {
              const r = await api<{ duplicateWarnings: Array<{ stationNumber: number; distanceM: number }> }>(`/api/admin/hosts/${pick.id}/location`, { method: "PUT", body: { lat, lon } });
              if (r.duplicateWarnings.length) toast(`Figyelem: ${r.duplicateWarnings.map((d) => `#${d.stationNumber} állomás ${d.distanceM} m-re`).join(", ")} van. Lehetséges duplikáció – a döntés a tiéd.`);
              reload();
            }} />
        </Sheet>
      )}
      {link && (
        <Sheet title="Új hozzáférési link" onClose={() => setLink(null)}>
          <Banner kind="warn" title="Csak most látható">Másold ki és juttasd el a résztvevőnek; a PIN változatlan.</Banner>
          <p><code style={{ wordBreak: "break-all" }}>{link}</code></p>
          <Button onClick={() => { void navigator.clipboard?.writeText(link); toast("Vágólapra másolva."); }}>Másolás</Button>
        </Sheet>
      )}
      {view && <ViewAs v={view} onClose={() => setView(null)} />}
      {edit && <TeamEdit team={edit} onClose={(s) => { setEdit(null); if (s) reload(); }} />}
      {dialog}
    </div>
  );
}

function TeamEdit({ team, onClose }: { team: Team; onClose: (saved: boolean) => void }) {
  const [name, setName] = useState(team.name); const [contact, setContact] = useState(team.contactName); const [phone, setPhone] = useState(team.phone);
  const a = useAction();
  return (
    <Sheet title="Csapat szerkesztése" onClose={() => onClose(false)}>
      <Banner kind="info">Az admin a módosítási határidő után is javíthat; a módosítás auditált.</Banner>
      <Field label="Csapatnév"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Kapcsolattartó"><Input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
      <Field label="Telefonszám"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <ErrorText error={a.error} />
      <Button disabled={a.busy} onClick={() => void a.run(async () => { await api(`/api/admin/teams/${team.id}`, { method: "PATCH", body: { name, contactName: contact, phone } }); onClose(true); })}>Mentés</Button>
    </Sheet>
  );
}

function ViewAs({ v, onClose }: { v: { kind: "team" | "host"; data: unknown }; onClose: () => void }) {
  const d = v.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <Sheet title={v.kind === "team" ? "Megtekintés csapatként (csak olvasható)" : "Megtekintés hostként (csak olvasható)"} onClose={onClose}>
      <Banner kind="info">Ez a nézet csak olvasható: innen nem lehet check-int, feltöltést vagy más résztvevői műveletet végezni. A megtekintés naplózódik.</Banner>
      {v.kind === "team" ? (
        <>
          <h3>{d.team.name}</h3>
          <p>{d.team.counts.total} fő ({d.team.counts.children} gyermek, {d.team.counts.adults} felnőtt)</p>
          <p>Haladás: <b>{d.progress.completed}/{d.progress.required}</b> · játékidő: {Math.floor(d.progress.elapsedSec / 60)} perc{d.progress.finished ? " · kész" : ""}</p>
          {d.stations.revealed ? <ul>{d.stations.stations.map((s: any) => <li key={s.id}>{s.label} – {s.address}</li>)}</ul> : <p className="muted">Az állomások helyszíne még nem látható ({d.stations.count} db).</p>}
        </>
      ) : (
        <>
          <h3>{d.dashboard.station?.label ?? "Nincs aktív állomás"}</h3>
          <p>{d.dashboard.station?.address}</p>
          <p>Látogatók: {d.dashboard.visits.length} · ajándék: {d.dashboard.gift?.status === "depleted" ? "elfogyott" : "van"}{d.dashboard.gift?.likelyOut ? " (valószínűleg elfogyott)" : ""}</p>
          <ul>{d.dashboard.visits.map((x: any, i: number) => <li key={i}>{x.teamName} – {x.total} fő</li>)}</ul>
        </>
      )}
    </Sheet>
  );
}

