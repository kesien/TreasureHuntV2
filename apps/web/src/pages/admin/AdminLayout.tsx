import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, setCsrf } from "../../api";
import { EVENT_STATUS_LABEL } from "../../format";
import { useEventTheme, useFetch, useLive } from "../../hooks";
import { Loading } from "../../components/ui";
import { useAdminMe } from "../../session";

export interface AdminEvent {
  id: string; name: string; type: string; status: string; shortDescription: string; rules: string; organizerContact: string; locality: string; checkinRadiusM: number;
  registrationStart: string; registrationClose: string; modificationDeadline: string; plannedStart: string; plannedEnd: string; actualStart: string | null; actualEnd: string | null;
  cancellationReason: string | null;
}
interface EventCtx { events: AdminEvent[]; current: AdminEvent | null; select: (id: string) => void; reload: () => void }
const Ctx = createContext<EventCtx>({ events: [], current: null, select: () => {}, reload: () => {} });
export const useAdminEvent = () => useContext(Ctx);

const NAV: Array<[string, string]> = [
  ["/admin", "Irányítópult"], ["/admin/esemenyek", "Események"], ["/admin/jelentkezok", "Csapatok és hostok"], ["/admin/allomasok", "Állomások"],
  ["/admin/fotok", "Fotók"], ["/admin/ellenorzes", "Ellenőrzés"], ["/admin/ertesitesek", "Értesítések"], ["/admin/naplo", "Audit napló"],
  ["/admin/rendszer", "Rendszerállapot"], ["/admin/adatkezeles", "Adatkezelési kérelmek"], ["/admin/adminok", "Adminok"], ["/admin/beallitasok", "Beállítások"],
];

export function AdminLayout() {
  const { me, refresh } = useAdminMe();
  const nav = useNavigate();
  const list = useFetch<AdminEvent[]>("/api/admin/events");
  useLive("/api/admin/stream", list.reload);
  const [sel, setSel] = useState<string | null>(() => { try { return localStorage.getItem("th_admin_event"); } catch { return null; } });
  const events = list.data ?? [];
  const current = events.find((e) => e.id === sel) ?? events.find((e) => e.status === "active") ?? events[0] ?? null;
  useEventTheme(current?.type);
  const select = (id: string) => { setSel(id); try { localStorage.setItem("th_admin_event", id); } catch { /* */ } };

  async function logout() { await api("/api/admin/logout", { method: "POST" }).catch(() => undefined); setCsrf(null); await refresh(); nav("/admin/belepes"); }

  return (
    <Ctx.Provider value={{ events, current, select, reload: list.reload }}>
      <div className="admin-shell">
        <nav className="admin-nav" aria-label="Admin navigáció">
          <p><b>Kincsvadászat admin</b><br /><span className="muted">{me?.displayName}</span></p>
          <label className="field" style={{ margin: "8px 0" }}>
            Aktuális esemény
            <select value={current?.id ?? ""} onChange={(e) => select(e.target.value)}>
              {events.map((e) => <option key={e.id} value={e.id}>{e.name} ({EVENT_STATUS_LABEL[e.status]})</option>)}
              {events.length === 0 && <option value="">Nincs esemény</option>}
            </select>
          </label>
          {NAV.map(([to, l]) => <NavLink key={to} to={to} end={to === "/admin"}>{l}</NavLink>)}
          <button type="button" className="btn secondary small" style={{ marginTop: 12 }} onClick={() => void logout()}>Kijelentkezés</button>
        </nav>
        <main className="admin-main">{list.loading && !list.data ? <Loading /> : <Outlet />}</main>
      </div>
    </Ctx.Provider>
  );
}

export function NeedEvent({ children }: { children: (e: AdminEvent) => ReactNode }) {
  const { current } = useAdminEvent();
  if (!current) return <p>Még nincs esemény. Hozz létre egyet az Események menüben.</p>;
  return <>{children(current)}</>;
}
