import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// Offline tároló: IndexedDB (a fotók Blob-ként is biztonságosan tárolhatók; localStorage erre nem alkalmas).
export type QueueStatus = "waiting" | "error";
export interface CheckInItem {
  id: string; // clientId – a szerver oldali idempotencia kulcsa
  type: "checkin";
  stationId: string;
  capturedAt: string; // a telefon szerinti eredeti idő
  latitude: number; // csak a szinkronig él, utána törlődik a sorral együtt
  longitude: number;
  accuracy: number | null;
  status: QueueStatus;
  error?: string;
  attempts: number;
  createdAt: string;
}
export interface PhotoItem {
  id: string;
  type: "photo";
  stationId: string;
  capturedAt: string;
  blob: Blob;
  fileName: string;
  status: QueueStatus;
  error?: string;
  attempts: number;
  createdAt: string;
}
export type QueueItem = CheckInItem | PhotoItem;

interface Schema extends DBSchema {
  queue: { key: string; value: QueueItem; indexes: { "by-type": string } };
  meta: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
export function db() {
  dbp ??= openDB<Schema>("th-offline", 1, {
    upgrade(d) {
      d.createObjectStore("queue", { keyPath: "id" }).createIndex("by-type", "type");
      d.createObjectStore("meta");
    },
  });
  return dbp;
}
/** Teszteléshez: a kapcsolat lezárása és a tároló törlése. */
export async function resetDbHandle() {
  if (dbp) (await dbp).close();
  dbp = null;
  await new Promise<void>((res, rej) => { const r = indexedDB.deleteDatabase("th-offline"); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

export class StorageFullError extends Error {
  constructor() { super("Nincs elég tárhely a telefonon, ezért ezt nem tudtuk elmenteni. A korábbi, szinkronra váró adatok megmaradtak."); }
}

export async function putItem(item: QueueItem): Promise<void> {
  try {
    await (await db()).put("queue", item);
  } catch (e) {
    if ((e as DOMException)?.name === "QuotaExceededError") throw new StorageFullError();
    throw e;
  }
}
export async function listItems(): Promise<QueueItem[]> {
  const all = await (await db()).getAll("queue");
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function removeItem(id: string) { await (await db()).delete("queue", id); }
export async function getMeta<T>(key: string): Promise<T | undefined> { return (await (await db()).get("meta", key)) as T | undefined; }
export async function setMeta(key: string, value: unknown) {
  try { await (await db()).put("meta", value, key); } catch { /* a pillanatkép elhagyható */ }
}
