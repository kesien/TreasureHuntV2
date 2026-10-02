import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { MapView, type Marker } from "../../components/MapView";
import { RoutePlanner } from "../../components/RoutePlanner";
import { PhotoGallery } from "../../components/Photos";
import { SyncBanner } from "../../components/SyncBanner";
import { Badge, Banner, Button, ErrorText, Loading, Sheet, useAction } from "../../components/ui";
import { ApiError, api, isNetworkError } from "../../api";
import { fmtDateTime, fmtDuration, PICKUP_LABEL } from "../../format";
import { GpsError, getPosition, navigationUrl } from "../../geo";
import { useFetch, useLive, useOnline, useTick, useToast } from "../../hooks";
import { StorageFullError } from "../../offline/db";
import { dismissNotice, enqueueCheckIn, localProximity, reasonText, useQueue } from "../../offline/queue";
import { GpsHelp, GuidePage } from "../Guide";
import { TeamProfile } from "./TeamProfile";

export interface TeamStation {
  id: string; number: number; label: string; address: string; latitude: number; longitude: number; pickupMode: string; participantNote: string | null;
  completed: boolean; giftStatus: "has_gifts" | "depleted"; giftNote: string | null; likelyOut: boolean;
}
interface StationsResp { revealed: boolean; count: number; radiusM?: number; center?: { lat: number; lon: number } | null; stations?: TeamStation[] }
interface Progress { firstCheckInAt: string | null; completed: number; required: number; finished: boolean; frozen: boolean; elapsedSec: number; completedStationIds: string[] }
export interface TeamInfo {
  id: string; name: string; status: string; counts: { children: number; adults: number; total: number };
  event: { id: string; name: string; status: string; modificationDeadline: string; plannedStart: string }; canModify: boolean;
}

export function TeamApp() {
  const team = useFetch<TeamInfo>("/api/access/team", { cacheKey: "team" });
  useEffect(() => { document.documentElement.dataset.theme = "halloween"; }, []);
  return (
    <>
      <Routes>
        <Route index element={<Stations team={team.data} reloadTeam={team.reload} />} />
        <Route path="profil" element={<TeamProfile team={team.data} reload={team.reload} />} />
        <Route path="utmutato" element={<GuidePage />} />
      </Routes>
      <nav className="tabbar" aria-label="Fő navigáció">
        <NavLink to="/csapat" end><span className="ico" aria-hidden>📍</span>Állomások</NavLink>
        <NavLink to="/csapat/profil"><span className="ico" aria-hidden>👥</span>Csapat</NavLink>
        <NavLink to="/csapat/utmutato"><span className="ico" aria-hidden>❓</span>Útmutató</NavLink>
      </nav>
    </>
  );
}

type Filter = "all" | "todo" | "done" | "out";

function Stations({ team, reloadTeam }: { team: TeamInfo | null; reloadTeam: () => void }) {
  const stationsQ = useFetch<StationsResp>("/api/access/stations", { cacheKey: "stations" });
  const progressQ = useFetch<Progress>("/api/access/progress", { cacheKey: "progress" });
  const q = useQueue();
  const online = useOnline();
  const [mode, setMode] = useState<"list" | "map">("map");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const reloadAll = useCallback(() => { stationsQ.reload(); progressQ.reload(); reloadTeam(); }, [stationsQ.reload, progressQ.reload, reloadTeam]);
  const live = useLive("/api/access/stream", reloadAll);
  // Szinkron után frissítjük a szerver szerinti állapotot
  useEffect(() => { if (q.lastSyncAt) reloadAll(); }, [q.lastSyncAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingStationIds = useMemo(() => new Set(q.items.filter((i) => i.type === "checkin").map((i) => i.stationId)), [q.items]);
  const stations = stationsQ.data?.stations ?? [];
  const eventActive = team?.event.status === "active";
  const rows = stations.map((s) => ({ ...s, done: s.completed || pendingStationIds.has(s.id), pending: !s.completed && pendingStationIds.has(s.id) }));
  const shown = rows.filter((s) => filter === "all" || (filter === "todo" && !s.done) || (filter === "done" && s.done) || (filter === "out" && (s.likelyOut || s.giftStatus === "depleted")));

  const markers: Marker[] = shown.map((s) => ({
    id: s.id, lat: s.latitude, lon: s.longitude, label: s.done ? "✓" : String(s.number),
    cls: s.done ? "done" : s.likelyOut || s.giftStatus === "depleted" ? "out" : "",
    title: `${s.label}${s.done ? ", teljesítve" : ""}${s.likelyOut ? ", valószínűleg elfogyott" : ""}`,
  }));
  const sel = rows.find((s) => s.id === selected) ?? null;
  const remainingForRoute = useMemo(() => rows.filter((s) => !s.done).map((s) => ({ id: s.id, number: s.number, label: s.label, latitude: s.latitude, longitude: s.longitude })), [rows]);

  if (stationsQ.loading && !stationsQ.data) return <div className="page"><Loading /></div>;
  const completedIds = new Set(rows.filter((s) => s.done).map((s) => s.id));
  const required = stations.length;
  const completed = completedIds.size;

  return (
    <>
      <header className="topbar">
        <b>{team?.event.name ?? "Kincsvadászat"}</b>
        <span className="muted" aria-live="polite">{live || !online ? (online ? "Élő" : "Offline") : "Frissítés…"}</span>
      </header>
      <div className="page">
        <SyncBanner />
        {stationsQ.error && !stationsQ.data && <ErrorBox error={stationsQ.error} />}
        {team?.event.status === "closed" && <Banner kind="info" title="Az esemény véget ért">Köszönjük a részvételt! A hozzáférésed az esemény után még egy hétig él.</Banner>}
        {team?.event.status === "cancelled" && <Banner kind="error" title="Az esemény elmarad" />}

        {stationsQ.data && !stationsQ.data.revealed && (
          <Banner kind="info" title="A helyszínek még nem láthatók">
            Összesen {stationsQ.data.count} állomás lesz. A pontos helyszínek az esemény kezdete előtt 24 órával jelennek meg{team ? ` (${fmtDateTime(team.event.plannedStart)})` : ""}.
          </Banner>
        )}
        {stationsQ.data?.revealed && !eventActive && team?.event.status !== "closed" && team?.event.status !== "cancelled" && (
          <Banner kind="info" title="Az esemény még nem indult el">Az „Megérkeztünk” gomb az esemény indulása után használható.</Banner>
        )}

        {stationsQ.data?.revealed && (
          <>
            <ProgressCard progress={progressQ.data} required={required} completed={completed} pendingIds={pendingStationIds} items={q.items} eventActive={!!eventActive} />
            <div className="row between">
              <div className="chips" role="group" aria-label="Szűrő">
                {([["all", "Összes"], ["todo", "Hátralévő"], ["done", "Teljesített"], ["out", "Valószínűleg elfogyott"]] as Array<[Filter, string]>).map(([k, l]) => (
                  <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
                ))}
              </div>
              <div className="chips" role="group" aria-label="Nézet">
                <button type="button" className="chip" aria-pressed={mode === "map"} onClick={() => setMode("map")}>Térkép</button>
                <button type="button" className="chip" aria-pressed={mode === "list"} onClick={() => setMode("list")}>Lista</button>
              </div>
            </div>
            {remainingForRoute.length > 0 && online && (
              <div className="row"><Button variant="secondary" small onClick={() => setRouting(true)}>🧭 Útvonal a hátralévő állomásokra</Button></div>
            )}
            {routing && <RoutePlanner remaining={remainingForRoute} onClose={() => setRouting(false)} />}
            {mode === "map" ? (
              <MapView markers={markers} center={stationsQ.data.center} onMarkerClick={setSelected} onUnavailable={() => setMode("list")} />
            ) : (
              <ul className="list">
                {shown.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="item" onClick={() => setSelected(s.id)}>
                      <span className={`num ${s.done ? "done" : s.likelyOut || s.giftStatus === "depleted" ? "out" : ""}`} aria-hidden>{s.done ? "✓" : s.number}</span>
                      <span style={{ flex: 1 }}>
                        <b>{s.label}</b><br />
                        <span className="muted">{s.address}</span>
                      </span>
                      <span>
                        {s.pending && <Badge kind="warn">Szinkronra vár</Badge>}
                        {s.done && !s.pending && <Badge kind="ok">Teljesítve</Badge>}
                        {s.giftStatus === "depleted" && <Badge kind="danger">Elfogyott</Badge>}
                        {s.likelyOut && s.giftStatus !== "depleted" && <Badge kind="warn">Valószínűleg elfogyott</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <p className="muted">Nincs a szűrésnek megfelelő állomás.</p>}
              </ul>
            )}
          </>
        )}
      </div>
      {sel && <StationSheet station={sel} pending={sel.pending} radiusM={stationsQ.data?.radiusM ?? 120} eventActive={!!eventActive} onClose={() => setSelected(null)} onChanged={reloadAll} />}
    </>
  );
}

function ErrorBox({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 403) return <Banner kind="warn" title="A hozzáférés nem aktív">{error.message}</Banner>;
  return <Banner kind="error" title="Nem sikerült betölteni">{error.message}</Banner>;
}

function ProgressCard({ progress, required, completed, pendingIds, items, eventActive }: {
  progress: Progress | null; required: number; completed: number; pendingIds: Set<string>; items: ReturnType<typeof useQueue>["items"]; eventActive: boolean;
}) {
  const now = useTick(1000);
  const pendingTimes = items.filter((i) => i.type === "checkin").map((i) => new Date(i.capturedAt).getTime());
  const serverFirst = progress?.firstCheckInAt ? new Date(progress.firstCheckInAt).getTime() : null;
  const first = [serverFirst, ...pendingTimes].filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  const finished = required > 0 && completed >= required;
  let elapsed = 0;
  if (first !== null) {
    if (progress?.frozen && pendingIds.size === 0 && progress.finished === finished) elapsed = progress.elapsedSec;
    else if (finished) elapsed = Math.max(0, (Math.max(...pendingTimes, serverFirst !== null ? serverFirst + (progress?.elapsedSec ?? 0) * 1000 : 0) - first) / 1000);
    else elapsed = Math.max(0, (now - first) / 1000);
  }
  return (
    <div className="card">
      <div className="row between">
        <div><span className="muted">Játékidő</span><div className="timer" role="timer" aria-label="Eltelt játékidő">{first === null ? "—" : fmtDuration(elapsed)}</div></div>
        <div style={{ textAlign: "right" }}><span className="muted">Teljesítve</span><div className="timer">{completed}/{required}</div></div>
      </div>
      {first === null && eventActive && <p className="muted" style={{ margin: "8px 0 0" }}>Az idő az első sikeres becsekkolásnál indul.</p>}
      {finished && <Banner kind="ok" title="Minden állomást teljesítettetek!">Gratulálunk! A játékidő megállt.</Banner>}
    </div>
  );
}

function StationSheet({ station, pending, radiusM, eventActive, onClose, onChanged }: {
  station: TeamStation & { done: boolean; pending: boolean }; pending: boolean; radiusM: number; eventActive: boolean; onClose: () => void; onChanged: () => void;
}) {
  const q = useQueue();
  const toast = useToast();
  const online = useOnline();
  const act = useAction();
  const [gps, setGps] = useState<null | "denied" | "unavailable" | "timeout" | "unsupported" | "inaccurate" | "too_far">(null);
  const [info, setInfo] = useState<string | null>(null);
  const notice = q.notices.find((n) => n.stationId === station.id);

  async function arrive() {
    setGps(null); setInfo(null);
    await act.run(async () => {
      let pos;
      try { pos = await getPosition(); } catch (e) { setGps(e instanceof GpsError ? e.kind : "unavailable"); return; }
      try {
        const r = await api<{ result: "ok" | "too_far" | "inaccurate"; distanceM?: number; radiusM?: number }>("/api/access/checkin", {
          body: { stationId: station.id, latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy },
        });
        if (r.result === "ok") { onChanged(); return; } // sikeres online check-in után nincs megerősítő ablak
        setGps(r.result);
        if (r.result === "too_far") setInfo(`Kb. ${r.distanceM} m-re vagytok; a megengedett távolság ${r.radiusM} m.`);
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        // Offline: helyi ellenőrzés, a szerver később újraellenőrzi
        const prox = localProximity(pos, station, radiusM);
        if (prox.result === "ok") {
          try { await enqueueCheckIn(station.id, pos); toast("Offline mentve – szinkronizálásra vár."); }
          catch (err) { if (err instanceof StorageFullError) throw err; throw new Error("A teljesítést nem sikerült elmenteni a telefonon."); }
        } else {
          setGps(prox.result);
          if (prox.result === "too_far") setInfo(`Kb. ${prox.distanceM} m-re vagytok; a megengedett távolság ${radiusM} m.`);
        }
      }
    });
  }

  async function reportOut() {
    await act.run(async () => {
      await api(`/api/access/stations/${station.id}/out-of-gifts`, { method: "POST" });
      toast("Köszönjük a jelzést!");
      onChanged();
    });
  }

  const serverDone = station.completed;
  return (
    <Sheet title={station.label} onClose={onClose}>
      {station.giftStatus === "depleted" && <Banner kind="error" title="Elfogyott az ajándék">{station.giftNote ?? "A házigazda jelezte, hogy elfogyott az ajándék. A becsekkolás ettől még lehetséges."}</Banner>}
      {station.likelyOut && station.giftStatus !== "depleted" && <Banner kind="warn" title="Valószínűleg elfogyott">Több csapat jelezte, hogy nincs több ajándék. A becsekkolás ettől még lehetséges.</Banner>}
      {notice && (
        <Banner kind="warn" title={notice.kind === "needs_review" ? "Az adminisztrátor ellenőrzi a teljesítést" : "A teljesítést nem fogadták el"}>
          {reasonText(notice.reason)} <Button small variant="secondary" onClick={() => void dismissNotice(station.id)}>Értem</Button>
        </Banner>
      )}
      <p><b>{station.address}</b></p>
      <p>{PICKUP_LABEL[station.pickupMode] ?? station.pickupMode}</p>
      {station.participantNote && <p className="muted">Megjegyzés: {station.participantNote}</p>}
      <div className="row">
        <a className="btn secondary" href={navigationUrl(station.latitude, station.longitude)} target="_blank" rel="noreferrer">🧭 Navigáció</a>
        {!station.done && <Button onClick={() => void arrive()} disabled={act.busy || !eventActive}>{act.busy ? "Helymeghatározás…" : "📍 Megérkeztünk"}</Button>}
        {station.done && <Badge kind={pending ? "warn" : "ok"}>{pending ? "Szinkronizálásra vár" : "Teljesítve"}</Badge>}
      </div>
      {!eventActive && !station.done && <p className="muted">A becsekkolás az esemény indulása után lehetséges.</p>}
      {!online && !station.done && <p className="muted">Offline vagy: a becsekkolást helyben mentjük, és később szinkronizáljuk.</p>}
      <ErrorText error={act.error} />
      {info && <p className="error-text" role="alert">{info}</p>}
      {gps && <GpsHelpBox kind={gps} onRetry={() => void arrive()} busy={act.busy} />}
      {station.done && (
        <>
          <PhotoGallery stationId={station.id} role="team" canUpload={eventActive} checkedInPending={pending} />
          {serverDone && eventActive && (
            <div style={{ marginTop: 16 }}>
              <Button variant="secondary" block onClick={() => void reportOut()} disabled={act.busy || !online}>🎁 Elfogyott az ajándék</Button>
              <p className="muted">Csak akkor jelezd, ha itt jártatok, és nincs több ajándék.</p>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function GpsHelpBox({ kind, onRetry, busy }: { kind: "denied" | "unavailable" | "timeout" | "unsupported" | "inaccurate" | "too_far"; onRetry: () => void; busy: boolean }) {
  const text: Record<string, string> = {
    denied: "Nem kaptunk engedélyt a helyadatokhoz.", unavailable: "Most nem sikerült meghatározni a helyzetedet.", timeout: "A helymeghatározás túl sokáig tartott.",
    unsupported: "Ez a böngésző nem támogatja a helymeghatározást.", inaccurate: "", too_far: "",
  };
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      {text[kind] && <Banner kind="error" title="GPS hiba">{text[kind]}</Banner>}
      <Button onClick={onRetry} disabled={busy}>Újrapróbálom</Button>
      <GpsHelp kind={kind} />
    </div>
  );
}
