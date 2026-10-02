import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, isNetworkError } from "./api";
import { getMeta, setMeta } from "./offline/db";

export interface FetchState<T> { data: T | null; error: Error | null; loading: boolean; offline: boolean; reload: () => void }

/**
 * Adatlekérés. cacheKey megadásakor a sikeres válasz IndexedDB-be kerül, hálózati hiba esetén onnan töltünk
 * (az offline használat látható adatai). A szerver az igazság forrása: online mindig frissít.
 */
export function useFetch<T>(path: string | null, opts: { cacheKey?: string } = {}): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [offline, setOffline] = useState(false);
  const seq = useRef(0);
  const run = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    try {
      const d = await api<T>(path);
      if (my !== seq.current) return;
      setData(d); setError(null); setOffline(false);
      if (opts.cacheKey) void setMeta(opts.cacheKey, d);
    } catch (e) {
      if (my !== seq.current) return;
      if (isNetworkError(e) && opts.cacheKey) {
        const cached = await getMeta<T>(opts.cacheKey);
        if (cached !== undefined) { setData(cached); setError(null); setOffline(true); setLoading(false); return; }
      }
      setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path, opts.cacheKey]);
  useEffect(() => { setLoading(!!path); void run(); }, [run, path]);
  return { data, error, loading, offline, reload: run };
}

export function useOnline(): boolean {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const u = () => setOn(true), d = () => setOn(false);
    window.addEventListener("online", u); window.addEventListener("offline", d);
    return () => { window.removeEventListener("online", u); window.removeEventListener("offline", d); };
  }, []);
  return on;
}

/** SSE jelzések; a szerver csak "változott" üzenetet küld, az adatot a normál API adja. Újracsatlakozáskor teljes frissítés. */
export function useLive(url: string | null, onChange: () => void): boolean {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      es = new EventSource(url);
      es.onopen = () => { setConnected(true); cb.current(); }; // reconnect után teljes frissítés
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = window.setTimeout(open, 5000);
      };
      for (const t of ["events", "applications", "stations", "checkin", "gift", "photo", "photos", "checkins", "gifts", "event", "backups"]) {
        es.addEventListener(t, () => cb.current());
      }
    };
    open();
    return () => { closed = true; window.clearTimeout(retry); es?.close(); setConnected(false); };
  }, [url]);
  return connected;
}

// ---------- Toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; msg: string }>>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l, { id, msg }]);
    window.setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((i) => <div key={i.id} className="toast">{i.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/** Ismétlődő frissítés (pl. időzítő). */
export function useTick(ms = 1000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setN(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return n;
}
