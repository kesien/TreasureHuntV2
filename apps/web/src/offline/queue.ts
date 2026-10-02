import { useSyncExternalStore } from "react";
import { ApiError, NetworkError, api, newKey } from "../api";
import { distanceMeters, MAX_ACCURACY_M, type Position } from "../geo";
import { getMeta, listItems, putItem, removeItem, setMeta, type CheckInItem, type PhotoItem, type QueueItem } from "./db";

/**
 * Offline sor: a check-in és a fotó először helyben tárolódik (IndexedDB), majd elemenként, idempotensen
 * szinkronizálódik. A szerver újraellenőriz és mindig ő dönt; a kliens sosem írja felül a szerver állapotát.
 * iOS-en nem építünk háttér-szinkronra: az app megnyitásakor / online eseménykor / kézi gombra fut.
 */
export interface Notice { stationId: string; kind: "needs_review" | "rejected"; reason?: string; at: string }
export interface QueueState {
  items: QueueItem[];
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  notices: Notice[];
}

let state: QueueState = { items: [], syncing: false, lastSyncAt: null, lastError: null, notices: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (p: Partial<QueueState>) => { state = { ...state, ...p }; emit(); };

export const getQueueState = () => state;
export const subscribeQueue = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useQueue(): QueueState {
  return useSyncExternalStore(subscribeQueue, getQueueState, getQueueState);
}

export async function reloadQueue() {
  const [items, notices, lastSyncAt] = await Promise.all([listItems(), getMeta<Notice[]>("notices"), getMeta<string>("lastSyncAt")]);
  set({ items, notices: notices ?? [], lastSyncAt: lastSyncAt ?? state.lastSyncAt });
}

export const REASON_TEXT: Record<string, string> = {
  unknown_station: "Ez az állomás már nem ismert a szerveren.",
  team_not_active: "A csapat hozzáférése már nem aktív.",
  event_cancelled: "Az esemény elmarad.",
  event_not_started: "Az esemény még nem indult el.",
  checkin_required: "A hozzá tartozó becsekkolás még nincs szinkronizálva.",
  photo_limit: "Ehhez az állomáshoz már elértétek az 5 fotós korlátot.",
  invalid_image: "A fotó nem dolgozható fel.",
  not_active: "Most nem lehet feltölteni.",
  station_removed: "Az állomás már nem része az eseménynek. Az adminisztrátor elbírálja.",
  server_error: "A szerver nem tudta feldolgozni.",
};
export const reasonText = (r?: string) => (r && REASON_TEXT[r]) || "A szerver nem fogadta el.";

// ---------- Hozzáadás ----------
// Szigorúan növekvő időbélyeg, hogy az azonos ezredmásodpercben sorba tett elemek sorrendje is stabil legyen.
let lastStamp = 0;
function monotonicIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

export async function enqueueCheckIn(stationId: string, pos: Position): Promise<CheckInItem> {
  const item: CheckInItem = {
    id: newKey(), type: "checkin", stationId, capturedAt: new Date().toISOString(),
    latitude: pos.latitude, longitude: pos.longitude, accuracy: pos.accuracy, status: "waiting", attempts: 0, createdAt: monotonicIso(),
  };
  await putItem(item); // StorageFullError esetén a korábbi elemek érintetlenek maradnak
  await reloadQueue();
  return item;
}

export async function enqueuePhoto(stationId: string, blob: Blob, fileName: string): Promise<PhotoItem> {
  const item: PhotoItem = {
    id: newKey(), type: "photo", stationId, capturedAt: new Date().toISOString(), blob, fileName, status: "waiting", attempts: 0, createdAt: monotonicIso(),
  };
  await putItem(item);
  await reloadQueue();
  return item;
}

/** Helyi proximity-ellenőrzés offline állapotban (a szerver később újraellenőrzi). */
export function localProximity(pos: Position, station: { latitude: number; longitude: number }, radiusM: number):
  { result: "ok"; distanceM: number } | { result: "too_far"; distanceM: number } | { result: "inaccurate"; accuracyM: number } {
  if (pos.accuracy > MAX_ACCURACY_M) return { result: "inaccurate", accuracyM: Math.round(pos.accuracy) };
  const d = distanceMeters(pos.latitude, pos.longitude, station.latitude, station.longitude);
  return d <= radiusM ? { result: "ok", distanceM: Math.round(d) } : { result: "too_far", distanceM: Math.round(d) };
}

export async function discardItem(id: string) { await removeItem(id); await reloadQueue(); }
export async function retryItem(id: string) {
  const it = (await listItems()).find((i) => i.id === id);
  if (it) { await putItem({ ...it, status: "waiting", error: undefined, attempts: 0 }); await reloadQueue(); }
}
export async function dismissNotice(stationId: string) {
  const notices = state.notices.filter((n) => n.stationId !== stationId);
  await setMeta("notices", notices);
  set({ notices });
}
async function addNotice(n: Notice) {
  const notices = [...state.notices.filter((x) => x.stationId !== n.stationId), n];
  await setMeta("notices", notices);
  set({ notices });
}

// ---------- Szinkron ----------
let running: Promise<void> | null = null;

/** Egy szinkronkör. manual=true: a hibás elemeket is újrapróbálja. Egyszerre csak egy kör fut. */
export function syncNow(opts: { manual?: boolean } = {}): Promise<void> {
  if (running) return running;
  running = doSync(!!opts.manual).finally(() => { running = null; set({ syncing: false }); });
  return running;
}

async function doSync(manual: boolean): Promise<void> {
  set({ syncing: true, lastError: null });
  try {
    let items = await listItems();
    if (manual) {
      for (const it of items.filter((i) => i.status === "error")) await putItem({ ...it, status: "waiting", error: undefined, attempts: 0 });
      items = await listItems();
    }
    const checkins = items.filter((i): i is CheckInItem => i.type === "checkin" && i.status === "waiting");
    for (let i = 0; i < checkins.length; i += 50) {
      const batch = checkins.slice(i, i + 50);
      const res = await api<{ results: Array<{ clientId: string; status: string; reason?: string; checkInStatus?: string }> }>("/api/access/sync/checkins", {
        body: { items: batch.map((c) => ({ clientId: c.id, stationId: c.stationId, capturedAt: c.capturedAt, latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy })) },
      });
      for (const r of res.results) {
        const it = batch.find((b) => b.id === r.clientId);
        if (!it) continue;
        if (r.status === "accepted" || (r.status === "duplicate" && r.checkInStatus !== "rejected" && r.checkInStatus !== "needs_review")) await removeItem(it.id);
        else if (r.status === "needs_review" || (r.status === "duplicate" && r.checkInStatus === "needs_review")) {
          await removeItem(it.id);
          await addNotice({ stationId: it.stationId, kind: "needs_review", reason: r.reason, at: new Date().toISOString() });
        } else if (r.status === "duplicate") { // korábban elutasított
          await removeItem(it.id);
          await addNotice({ stationId: it.stationId, kind: "rejected", at: new Date().toISOString() });
        } else await putItem({ ...it, status: "error", error: reasonText(r.reason), attempts: it.attempts + 1 });
      }
    }
    // Fotók: elemenként, egy hiba nem blokkol másikat
    const photos = (await listItems()).filter((i): i is PhotoItem => i.type === "photo" && i.status === "waiting");
    for (const p of photos) {
      const form = new FormData();
      form.append("clientId", p.id);
      form.append("capturedAt", p.capturedAt);
      form.append("file", p.blob, p.fileName);
      try {
        await api(`/api/access/stations/${p.stationId}/photos`, { form });
        await removeItem(p.id);
      } catch (e) {
        if (e instanceof NetworkError) throw e;
        if (e instanceof ApiError && (e.status === 401 || e.status === 429)) throw e;
        const code = e instanceof ApiError ? e.code : "server_error";
        const stillPendingCheckIn = (await listItems()).some((i) => i.type === "checkin" && i.stationId === p.stationId);
        if (code === "checkin_required" && (stillPendingCheckIn || p.attempts < 3)) await putItem({ ...p, attempts: p.attempts + 1 });
        else await putItem({ ...p, status: "error", error: reasonText(code), attempts: p.attempts + 1 });
      }
    }
    const at = new Date().toISOString();
    await setMeta("lastSyncAt", at);
    set({ lastSyncAt: at });
  } catch (e) {
    if (e instanceof NetworkError) set({ lastError: "Nem sikerült szinkronizálni. A rendszer újra megpróbálja, amikor internetkapcsolat áll rendelkezésre." });
    else if (e instanceof ApiError && e.status === 401) set({ lastError: "A szinkronizáláshoz lépj be újra a linkeddel és a PIN kóddal. Az offline adatok megmaradtak." });
    else if (e instanceof ApiError && e.status === 429) set({ lastError: "Túl sok kérés. Pár perc múlva újra megpróbáljuk." });
    else set({ lastError: "Nem sikerült szinkronizálni. A rendszer később újra megpróbálja." });
  } finally {
    await reloadQueue();
  }
}

/** Automatikus triggerek: indulás, online esemény, láthatóvá válás, időzítő. Egyszer kell hívni. */
export function initSync(): () => void {
  void reloadQueue().then(() => { if (state.items.some((i) => i.status === "waiting")) void syncNow(); });
  void navigator.storage?.persist?.().catch(() => undefined); // kérés a böngészőtől; nem garancia
  const kick = () => { if (navigator.onLine && state.items.some((i) => i.status === "waiting")) void syncNow(); };
  const vis = () => { if (document.visibilityState === "visible") kick(); };
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", vis);
  const t = window.setInterval(kick, 30_000);
  return () => { window.removeEventListener("online", kick); document.removeEventListener("visibilitychange", vis); window.clearInterval(t); };
}

export const summarize = (items: QueueItem[]) => ({
  checkins: items.filter((i) => i.type === "checkin").length,
  photos: items.filter((i) => i.type === "photo").length,
  errors: items.filter((i) => i.status === "error").length,
});
