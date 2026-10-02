import type { EventStatus } from "./statuses.js";

const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["registration_open", "cancelled"],
  registration_open: ["preparation", "cancelled"],
  preparation: ["active", "registration_open", "cancelled"],
  active: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(s: EventStatus): boolean {
  return s === "closed" || s === "cancelled";
}

const HOUR = 3600_000;

/**
 * T−24 felfedés időpontja. Indításig a tervezett kezdésből számol; ha az esemény
 * a T−24 előtt indult, a felfedés az indítás pillanata (M0 döntés).
 */
export function revealAt(plannedStart: Date, actualStart: Date | null): Date {
  const t24 = new Date(plannedStart.getTime() - 24 * HOUR);
  if (actualStart && actualStart < t24) return actualStart;
  return t24;
}

export function locationsRevealed(
  now: Date,
  plannedStart: Date,
  actualStart: Date | null,
  status: EventStatus,
): boolean {
  if (status === "active" || status === "closed") return true;
  if (status === "cancelled" || status === "draft") return false;
  return now >= revealAt(plannedStart, actualStart);
}

export interface EventDates {
  registrationStart: Date;
  registrationClose: Date;
  modificationDeadline: Date;
  plannedStart: Date;
  plannedEnd: Date;
}

/** Dátumsorrend ellenőrzés; hibalista (üres = rendben). */
export function validateEventDates(d: EventDates): string[] {
  const errs: string[] = [];
  if (d.registrationStart >= d.registrationClose) errs.push("A jelentkezés kezdete a lezárás előtt kell legyen.");
  if (d.modificationDeadline > d.plannedStart) errs.push("A módosítási határidő nem lehet az esemény kezdete után.");
  if (d.registrationClose > d.plannedStart) errs.push("A jelentkezés lezárása nem lehet az esemény kezdete után.");
  if (d.plannedStart >= d.plannedEnd) errs.push("Az esemény kezdete a vége előtt kell legyen.");
  return errs;
}

export function modificationAllowed(now: Date, modificationDeadline: Date, status: EventStatus): boolean {
  return !isTerminal(status) && status !== "active" && now <= modificationDeadline;
}
