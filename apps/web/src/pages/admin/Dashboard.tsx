import { useCallback } from "react";
import { Link } from "react-router-dom";
import { Banner, Loading } from "../../components/ui";
import { MapView, type Marker } from "../../components/MapView";
import { fmtDateTime, EVENT_STATUS_LABEL } from "../../format";
import { useFetch, useLive } from "../../hooks";
import { NeedEvent, type AdminEvent } from "./AdminLayout";

interface Stats {
  teams: { approved: number; pending: number; withdrawn: number; rejected: number }; hosts: { approved: number; pending: number; withdrawn: number };
  participants: { total: number; children: number; adults: number }; stations: number; completedCheckIns: number; completedTeams: number; partialTeams: number;
  photos: number; outOfGiftsReports: number; likelyOutStations: number; pendingApplications: number; reviewsPending: number; reportedPhotos: number;
}
interface MapStation { id: string; number: number; address: string; latitude: number; longitude: number; virtual: boolean; status: string; gift: { status: string; reports: number; likelyOut: boolean } | null }

export function Dashboard() {
  return <NeedEvent>{(e) => <DashboardFor event={e} />}</NeedEvent>;
}

function DashboardFor({ event }: { event: AdminEvent }) {
  const stats = useFetch<Stats>(`/api/admin/events/${event.id}/stats`);
  const map = useFetch<MapStation[]>(`/api/admin/events/${event.id}/map`);
  const refresh = useCallback(() => { stats.reload(); map.reload(); }, [stats.reload, map.reload]);
  useLive("/api/admin/stream", refresh); // automatikus frissítés
  const s = stats.data;
  const markers: Marker[] = (map.data ?? []).filter((m) => m.status === "active").map((m) => ({
    id: m.id, lat: m.latitude, lon: m.longitude, label: String(m.number),
    cls: m.gift?.status === "depleted" || m.gift?.likelyOut ? "out" : "", title: `Állomás #${m.number}${m.gift?.likelyOut ? " – valószínűleg elfogyott" : ""}`,
  }));
  return (
    <div className="stack">
      <h1>{event.name}</h1>
      <p className="muted">{EVENT_STATUS_LABEL[event.status]} · kezdés: {fmtDateTime(event.plannedStart)}{event.actualStart ? ` (tényleges: ${fmtDateTime(event.actualStart)})` : ""}</p>
      {!s ? <Loading /> : (
        <>
          {s.pendingApplications > 0 && <Banner kind="warn" title={`${s.pendingApplications} elbírálásra váró jelentkezés`}><Link to="/admin/jelentkezok">Megnyitás</Link></Banner>}
          {s.reviewsPending > 0 && <Banner kind="warn" title={`${s.reviewsPending} check-in elbírálásra vár`}><Link to="/admin/ellenorzes">Megnyitás</Link></Banner>}
          {s.reportedPhotos > 0 && <Banner kind="warn" title={`${s.reportedPhotos} jelentett fotó`}><Link to="/admin/fotok">Megnyitás</Link></Banner>}
          {s.likelyOutStations > 0 && <Banner kind="warn" title={`${s.likelyOutStations} állomáson valószínűleg elfogyott az ajándék`} />}
          <div className="grid">
            <Stat n={s.teams.approved} l="jóváhagyott csapat" /><Stat n={s.teams.pending} l="függő csapat" /><Stat n={s.hosts.approved} l="jóváhagyott host" />
            <Stat n={s.participants.total} l="résztvevő" /><Stat n={s.participants.children} l="gyermek" /><Stat n={s.participants.adults} l="felnőtt" />
            <Stat n={s.stations} l="állomás" /><Stat n={s.completedCheckIns} l="teljesített check-in" /><Stat n={s.completedTeams} l="minden állomást teljesítő csapat" />
            <Stat n={s.partialTeams} l="részben teljesítő csapat" /><Stat n={s.photos} l="fotó" /><Stat n={s.outOfGiftsReports} l="elfogyás-jelzés" />
          </div>
        </>
      )}
      <h2>Állomások térképe</h2>
      {markers.length ? <MapView markers={markers} /> : <p className="muted">Még nincs állomás.</p>}
    </div>
  );
}
const Stat = ({ n, l }: { n: number; l: string }) => <div className="stat"><b>{n}</b>{l}</div>;
