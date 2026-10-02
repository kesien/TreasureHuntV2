// Magyar dátum/idő formátum, 24 órás, Europe/Budapest időzóna.
const TZ = "Europe/Budapest";
const dt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const d = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
const t = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dt.format(new Date(v)) : "–");
export const fmtDate = (v: string | Date | null | undefined) => (v ? d.format(new Date(v)) : "–");
export const fmtTime = (v: string | Date | null | undefined) => (v ? t.format(new Date(v)) : "–");

export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/** datetime-local mező érték (Budapest idő) ↔ ISO. */
export function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return parts.replace(" ", "T");
}
export function fromLocalInput(v: string): string {
  // A megadott érték Budapest helyi idő; az eltolást az adott dátumra számoljuk ki
  const guess = new Date(v + ":00Z");
  const asBudapest = new Date(new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(guess).replace(" ", "T") + "Z");
  const offset = asBudapest.getTime() - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export const PICKUP_LABEL: Record<string, string> = { gift_outside: "Az ajándék kint van", ring_bell: "Csengess / menj be" };
export const EVENT_STATUS_LABEL: Record<string, string> = {
  draft: "Tervezés", registration_open: "Jelentkezés nyitva", preparation: "Előkészítés", active: "Folyamatban", closed: "Lezárva", cancelled: "Elmarad",
};
export const PARTICIPANT_STATUS_LABEL: Record<string, string> = {
  pending: "Függőben", approved: "Jóváhagyva", rejected: "Elutasítva", withdrawn: "Visszalépett", removed: "Eseményből eltávolítva",
  expired: "Lejárt – nem került jóváhagyásra", archived: "Archivált",
};
