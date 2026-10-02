import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, api, isNetworkError, setCsrf } from "./api";
import { getMeta, setMeta } from "./offline/db";
import { Loading } from "./components/ui";

export interface AccessMe { role: "team" | "host"; csrfToken: string; eventType?: "halloween" | "easter" }
export interface AdminMe { id: string; email: string; displayName: string; csrfToken: string }

interface Ctx<T> { me: T | null; loading: boolean; refresh: () => Promise<void> }
const AccessCtx = createContext<Ctx<AccessMe>>({ me: null, loading: true, refresh: async () => {} });
const AdminCtx = createContext<Ctx<AdminMe>>({ me: null, loading: true, refresh: async () => {} });
export const useAccessMe = () => useContext(AccessCtx);
export const useAdminMe = () => useContext(AdminCtx);

/** A munkamenet a sütiből él; offline induláskor az utolsó ismert szerepkörrel nyitunk (az adatok pillanatképből jönnek). */
export function AccessProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AccessMe | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      const m = await api<AccessMe>("/api/access/me");
      setCsrf(m.csrfToken); setMe(m); void setMeta("access-me", m);
    } catch (e) {
      if (isNetworkError(e)) setMe((await getMeta<AccessMe>("access-me")) ?? null);
      else if (e instanceof ApiError && e.status === 401) { setMe(null); void setMeta("access-me", null); }
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <AccessCtx.Provider value={{ me, loading, refresh }}>{children}</AccessCtx.Provider>;
}

export function AdminProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      const m = await api<AdminMe>("/api/admin/me");
      setCsrf(m.csrfToken); setMe(m);
    } catch { setMe(null); } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <AdminCtx.Provider value={{ me, loading, refresh }}>{children}</AdminCtx.Provider>;
}

export function RequireAccess({ role, children }: { role: "team" | "host"; children: ReactNode }) {
  const { me, loading } = useAccessMe();
  const loc = useLocation();
  if (loading) return <div className="page"><Loading /></div>;
  if (!me) return <Navigate to="/belepes" state={{ from: loc.pathname }} replace />;
  if (me.role !== role) return <Navigate to={me.role === "team" ? "/csapat" : "/host"} replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me, loading } = useAdminMe();
  if (loading) return <div className="page"><Loading /></div>;
  if (!me) return <Navigate to="/admin/belepes" replace />;
  return <>{children}</>;
}
