import { and, eq, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { distanceMeters, modificationAllowed, normalizeHuPhone, validatePin, type EventStatus, type MemberCategory, type PickupMode } from "@th/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { accessCredentials, events, hosts, participantTokens, policyConsents, teamMembers, teams } from "../db/schema.js";
import { hashToken, newToken } from "../lib/crypto.js";
import { pgError } from "../lib/dbError.js";
import { AccessError, changePin, createCredential, revokeAccess, type SubjectType } from "./accessAuth.js";
import { audit } from "./audit.js";
import { enqueueEmail, notifyAdmins } from "./outbox.js";
import { deactivateHostStation, ensureHostStation } from "./stations.js";
import { hit } from "./rateLimit.js";
import type { TemplateData } from "./templates.js";

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); }
}

export const POLICY_VERSION = "2026-1";
const PIN_RECOVERY_TTL_MS = 30 * 60_000;
const EMAIL_CHANGE_TTL_MS = 24 * 3600_000;

export function formatHu(d: Date): string {
  return new Intl.DateTimeFormat("hu-HU", {
    timeZone: "Europe/Budapest", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

/** Cím normalizálása a duplikáció-ellenőrzéshez: kisbetű, ékezet nélkül, írásjelek nélkül. */
export function normalizeAddress(a: string): string {
  return a.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.,;:\/\\-]/g, " ").replace(/\butca\b/g, "u").replace(/\s+/g, " ").trim();
}

const isUnique = (e: unknown, name: string) => { const p = pgError(e); return p.code === "23505" && p.constraint === name; };

async function loadEvent(db: Db, eventId: string) {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw new AppError("not_found", "Az esemény nem található.", 404);
  return ev;
}

function eventData(ev: typeof events.$inferSelect): TemplateData {
  return {
    eventName: ev.name, organizerContact: ev.organizerContact || undefined,
    plannedStart: formatHu(ev.plannedStart), modificationDeadline: formatHu(ev.modificationDeadline), registrationClose: formatHu(ev.registrationClose),
  };
}

function assertRegistrationOpen(ev: typeof events.$inferSelect, now = new Date()) {
  if (ev.status !== "registration_open" || now < ev.registrationStart || now > ev.registrationClose) {
    throw new AppError("registration_closed", "A jelentkezés jelenleg nem elérhető.", 409);
  }
}

function newRandomPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (validatePin(pin).ok) return pin;
  }
}

// ---------- Jelentkezés ----------
export interface TeamApplication {
  name: string; contactName: string; email: string; phone: string;
  members: Array<{ name: string; category: MemberCategory }>;
  consent: boolean;
}

export async function submitTeam(db: Db, cfg: Config, eventId: string, input: TeamApplication, idemKey: string) {
  const ev = await loadEvent(db, eventId);
  assertRegistrationOpen(ev);
  if (!input.consent) throw new AppError("consent_required", "Az adatkezelési tájékoztató elfogadása kötelező.");
  const phone = normalizeHuPhone(input.phone);
  if (!phone) throw new AppError("invalid_phone", "Adj meg érvényes magyar telefonszámot, pl. +36 30 123 4567.");
  if (!input.members.some((m) => m.category === "child")) throw new AppError("child_required", "Legalább egy gyermek tagnak szerepelnie kell a csapatban.");

  const [dup] = await db.select().from(teams).where(and(eq(teams.eventId, eventId), eq(teams.idempotencyKey, idemKey)));
  if (dup) return { id: dup.id, duplicate: true };

  try {
    const team = await db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values({
        eventId, name: input.name.trim(), contactName: input.contactName.trim(), email: input.email.trim().toLowerCase(), phone, idempotencyKey: idemKey,
      }).returning();
      await tx.insert(teamMembers).values(input.members.map((m) => ({ teamId: t!.id, name: m.name.trim(), category: m.category })));
      await tx.insert(policyConsents).values({ subjectType: "team", subjectId: t!.id, eventId, kind: "privacy", version: POLICY_VERSION });
      await audit(tx, { actorType: "system", action: "team.apply", entityType: "team", entityId: t!.id, eventId });
      await enqueueEmail(tx, cfg, { type: "application_received", recipient: t!.email, data: { ...eventData(ev), role: "team" }, dedupKey: `application_received:team:${t!.id}`, eventId, entityType: "team", entityId: t!.id });
      await notifyAdmins(tx, cfg, "Új csapat-jelentkezés", `Új csapat jelentkezett: ${t!.name}.`, `admin_new_team:${t!.id}`, eventId);
      return t!;
    });
    return { id: team.id, duplicate: false };
  } catch (e) {
    // Párhuzamos dupla küldésnél előbb az idempotencia-kulcsot nézzük, csak utána a névütközést
    const [d] = await db.select().from(teams).where(and(eq(teams.eventId, eventId), eq(teams.idempotencyKey, idemKey)));
    if (d) return { id: d.id, duplicate: true };
    if (isUnique(e, "teams_event_name_uq")) throw new AppError("name_taken", "Ez a csapatnév már foglalt ezen az eseményen.", 409);
    throw e;
  }
}

export interface HostApplication {
  contactName: string; email: string; phone: string; address: string;
  pickupMode: PickupMode; participantNote?: string; consent: boolean;
  /** A host a jelentkezéskor maga erősíti meg a térképen; hiányában az admin erősít meg jóváhagyás előtt. */
  location?: { lat: number; lon: number; placeId?: string };
}

export const MAX_LOCATION_DISTANCE_M = 50_000;

export async function submitHost(db: Db, cfg: Config, eventId: string, input: HostApplication, idemKey: string) {
  const ev = await loadEvent(db, eventId);
  assertRegistrationOpen(ev);
  if (!input.consent) throw new AppError("consent_required", "Az adatkezelési tájékoztató elfogadása kötelező.");
  const phone = normalizeHuPhone(input.phone);
  if (!phone) throw new AppError("invalid_phone", "Adj meg érvényes magyar telefonszámot, pl. +36 30 123 4567.");
  const [dup] = await db.select().from(hosts).where(and(eq(hosts.eventId, eventId), eq(hosts.idempotencyKey, idemKey)));
  if (dup) return { id: dup.id, duplicate: true };
  const loc = input.location;
  if (loc) {
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) throw new AppError("invalid_location", "Hibás pozíció.");
    // Ésszerűségi ellenőrzés: az esemény településétől messze lévő pont valószínűleg elírás
    if (ev.centerLat != null && ev.centerLon != null && distanceMeters(loc.lat, loc.lon, ev.centerLat, ev.centerLon) > MAX_LOCATION_DISTANCE_M) {
      throw new AppError("invalid_location", "A megadott pozíció túl messze van az esemény településétől. Ellenőrizd a címet és a jelölőt.");
    }
  }
  try {
    const host = await db.transaction(async (tx) => {
      const [h] = await tx.insert(hosts).values({
        ...(loc ? { latitude: loc.lat, longitude: loc.lon, locationConfirmed: true, placeId: loc.placeId ?? null } : {}),
        eventId, contactName: input.contactName.trim(), email: input.email.trim().toLowerCase(), phone,
        address: input.address.trim(), normalizedAddress: normalizeAddress(input.address),
        pickupMode: input.pickupMode, participantNote: input.participantNote?.trim() || null, idempotencyKey: idemKey,
      }).returning();
      await tx.insert(policyConsents).values({ subjectType: "host", subjectId: h!.id, eventId, kind: "privacy", version: POLICY_VERSION });
      await audit(tx, { actorType: "system", action: "host.apply", entityType: "host", entityId: h!.id, eventId });
      await enqueueEmail(tx, cfg, { type: "application_received", recipient: h!.email, data: { ...eventData(ev), role: "host" }, dedupKey: `application_received:host:${h!.id}`, eventId, entityType: "host", entityId: h!.id });
      await notifyAdmins(tx, cfg, "Új állomás-jelentkezés", `Új állomás jelentkezett: ${h!.address}.`, `admin_new_host:${h!.id}`, eventId);
      return h!;
    });
    return { id: host.id, duplicate: false };
  } catch (e) {
    const [d] = await db.select().from(hosts).where(and(eq(hosts.eventId, eventId), eq(hosts.idempotencyKey, idemKey)));
    if (d) return { id: d.id, duplicate: true };
    if (isUnique(e, "hosts_event_address_uq")) throw new AppError("address_taken", "Erre a címre már van jelentkezés ezen az eseményen.", 409);
    throw e;
  }
}

// ---------- Admin: jóváhagyás / elutasítás ----------
const table = (t: SubjectType) => (t === "team" ? teams : hosts);

async function loadSubject(db: Db, type: SubjectType, id: string) {
  const [row] = await db.select().from(table(type)).where(eq(table(type).id, id));
  if (!row) throw new AppError("not_found", "A jelentkezés nem található.", 404);
  const ev = await loadEvent(db, row.eventId);
  return { row, ev };
}

function accessLink(cfg: Config, token: string) {
  return `${cfg.PUBLIC_BASE_URL}/belepes/${token}`;
}

export async function approve(db: Db, cfg: Config, adminId: string, type: SubjectType, id: string) {
  const { row, ev } = await loadSubject(db, type, id);
  if (row.status !== "pending") throw new AppError("bad_state", "Csak függő jelentkezés hagyható jóvá.", 409);
  if (ev.status === "active" || ev.status === "closed" || ev.status === "cancelled") {
    throw new AppError("event_started", "Az esemény már elindult, a függő jelentkezés nem hagyható jóvá.", 409);
  }
  const pin = newRandomPin();
  const late = new Date() > ev.modificationDeadline;
  const hasCredential = (await db.select({ id: accessCredentials.id }).from(accessCredentials).where(and(eq(accessCredentials.subjectType, type), eq(accessCredentials.subjectId, id)))).length > 0;
  let token = "";
  await db.transaction(async (tx) => {
    if (type === "host") await ensureHostStation(tx as never, row as typeof hosts.$inferSelect); // pozíció nélkül hibát dob
    await tx.update(table(type)).set({ status: "approved", approvedAt: new Date(), statusReason: null, updatedAt: new Date() }).where(eq(table(type).id, id));
    if (hasCredential) { // pl. újra jóváhagyás címváltozás után: meglévő hozzáférés marad
      await audit(tx, { actorType: "admin", actorId: adminId, action: `${type}.approve`, entityType: type, entityId: id, eventId: ev.id, after: { late, reapproval: true } });
      return;
    }
    token = (await createCredential(tx as unknown as Db, type, id, ev.id, pin)).token;
    await audit(tx, { actorType: "admin", actorId: adminId, action: `${type}.approve`, entityType: type, entityId: id, eventId: ev.id, after: { late } });
    await enqueueEmail(tx, cfg, {
      type: "approval", recipient: row.email, data: { ...eventData(ev), role: type, link: accessLink(cfg, token), pin },
      dedupKey: `approval:${type}:${id}`, eventId: ev.id, entityType: type, entityId: id,
    });
  });
  return { late, warnings: late ? ["A módosítási határidő után hagytad jóvá; csak a jóváhagyáskori adatok érvényesek."] : [] };
}

export async function reject(db: Db, cfg: Config, adminId: string, type: SubjectType, id: string, reason: string) {
  if (!reason.trim()) throw new AppError("reason_required", "Az elutasítás indoklása kötelező.");
  const { row, ev } = await loadSubject(db, type, id);
  if (row.status !== "pending") throw new AppError("bad_state", "Csak függő jelentkezés utasítható el.", 409);
  await db.transaction(async (tx) => {
    await tx.update(table(type)).set({ status: "rejected", statusReason: reason, updatedAt: new Date() }).where(eq(table(type).id, id));
    await audit(tx, { actorType: "admin", actorId: adminId, action: `${type}.reject`, entityType: type, entityId: id, eventId: ev.id, reason });
    await enqueueEmail(tx, cfg, { type: "rejection", recipient: row.email, data: { ...eventData(ev), role: type, reason }, dedupKey: `rejection:${type}:${id}`, eventId: ev.id, entityType: type, entityId: id });
  });
}

/** Új hozzáférés kiadása (pl. elveszett levél): új PIN + új link, a régi sessionök megszűnnek. */
export async function reissueAccess(db: Db, cfg: Config, adminId: string, type: SubjectType, id: string) {
  const { row, ev } = await loadSubject(db, type, id);
  if (row.status !== "approved") throw new AppError("bad_state", "Csak jóváhagyott szereplőnek adható ki hozzáférés.", 409);
  const pin = newRandomPin();
  await db.transaction(async (tx) => {
    await revokeAccess(tx as unknown as Db, { subjectType: type, subjectId: id });
    await tx.delete(accessCredentials).where(and(eq(accessCredentials.subjectType, type), eq(accessCredentials.subjectId, id)));
    const { token } = await createCredential(tx as unknown as Db, type, id, ev.id, pin);
    await audit(tx, { actorType: "admin", actorId: adminId, action: "access.reissued", entityType: type, entityId: id, eventId: ev.id });
    await enqueueEmail(tx, cfg, {
      type: "approval", recipient: row.email, data: { ...eventData(ev), role: type, link: accessLink(cfg, token), pin },
      dedupKey: `approval:${type}:${id}:${Date.now()}`, eventId: ev.id, entityType: type, entityId: id,
    });
  });
}

// ---------- Résztvevő: visszalépés ----------
function assertParticipantEditable(ev: typeof events.$inferSelect, status: string, adminOverride = false) {
  if (!["pending", "approved"].includes(status)) throw new AppError("bad_state", "Ez a jelentkezés már nem módosítható.", 409);
  if (adminOverride) return; // az admin a határidő után is javíthat (auditálva)
  if (!modificationAllowed(new Date(), ev.modificationDeadline, ev.status as EventStatus)) {
    throw new AppError("deadline_passed", "A módosítási határidő lejárt.", 409);
  }
}

export async function withdraw(db: Db, cfg: Config, type: SubjectType, id: string, confirm: boolean) {
  if (!confirm) throw new AppError("confirm_required", "Erősítsd meg a visszalépést.");
  const { row, ev } = await loadSubject(db, type, id);
  assertParticipantEditable(ev, row.status);
  await db.transaction(async (tx) => {
    await tx.update(table(type)).set({ status: "withdrawn", updatedAt: new Date() }).where(eq(table(type).id, id));
    await revokeAccess(tx as unknown as Db, { subjectType: type, subjectId: id });
    if (type === "host") await deactivateHostStation(tx, id, "host_withdrawn");
    await audit(tx, { actorType: type, actorId: id, action: `${type}.withdraw`, entityType: type, entityId: id, eventId: ev.id });
    await enqueueEmail(tx, cfg, { type: "withdrawal", recipient: row.email, data: { ...eventData(ev), role: type }, dedupKey: `withdrawal:${type}:${id}`, eventId: ev.id, entityType: type, entityId: id });
    await notifyAdmins(tx, cfg, "Visszalépés", `Visszalépett: ${type === "team" ? (row as typeof teams.$inferSelect).name : (row as typeof hosts.$inferSelect).address}.`, `admin_withdraw:${type}:${id}`, ev.id);
  });
}

// ---------- Résztvevő: módosítás ----------
export async function getTeam(db: Db, id: string) {
  const [t] = await db.select().from(teams).where(eq(teams.id, id));
  if (!t) throw new AppError("not_found", "Nem található.", 404);
  const members = await db.select({ id: teamMembers.id, name: teamMembers.name, category: teamMembers.category }).from(teamMembers).where(eq(teamMembers.teamId, id));
  const children = members.filter((m) => m.category === "child").length;
  const ev = await loadEvent(db, t.eventId);
  return {
    id: t.id, name: t.name, contactName: t.contactName, email: t.email, pendingEmail: t.pendingEmail, phone: t.phone, status: t.status,
    members, counts: { children, adults: members.length - children, total: members.length },
    event: { id: ev.id, name: ev.name, status: ev.status, modificationDeadline: ev.modificationDeadline, plannedStart: ev.plannedStart },
    canModify: modificationAllowed(new Date(), ev.modificationDeadline, ev.status as EventStatus) && ["pending", "approved"].includes(t.status),
  };
}

const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

export async function updateTeam(
  db: Db, id: string,
  patch: Partial<{ name: string; contactName: string; phone: string; members: Array<{ name: string; category: MemberCategory }> }>,
  adminId?: string,
) {
  const { row, ev } = await loadSubject(db, "team", id);
  assertParticipantEditable(ev, row.status, !!adminId);
  const t = row as typeof teams.$inferSelect;
  const set: Partial<typeof teams.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.contactName !== undefined) set.contactName = patch.contactName.trim();
  if (patch.phone !== undefined) {
    const p = normalizeHuPhone(patch.phone);
    if (!p) throw new AppError("invalid_phone", "Adj meg érvényes magyar telefonszámot.");
    set.phone = p;
  }
  if (patch.members && !patch.members.some((m) => m.category === "child")) throw new AppError("child_required", "Legalább egy gyermek tagnak szerepelnie kell a csapatban.");
  try {
    await db.transaction(async (tx) => {
      await tx.update(teams).set(set).where(eq(teams.id, id));
      if (patch.members) {
        await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
        await tx.insert(teamMembers).values(patch.members.map((m) => ({ teamId: id, name: m.name.trim(), category: m.category })));
      }
      // Auditban csak a módosított mezők nevei szerepelnek (nincs felesleges személyes adat)
      const fields = [...changedFields({ name: t.name, contactName: t.contactName, phone: t.phone }, set as Record<string, unknown>).filter((f) => f !== "updatedAt"), ...(patch.members ? ["members"] : [])];
      await audit(tx, { actorType: adminId ? "admin" : "team", actorId: adminId ?? id, action: "team.edit", entityType: "team", entityId: id, eventId: ev.id, after: { fields, byAdmin: !!adminId } });
    });
  } catch (e) {
    if (isUnique(e, "teams_event_name_uq")) throw new AppError("name_taken", "Ez a csapatnév már foglalt ezen az eseményen.", 409);
    throw e;
  }
}

export async function getHost(db: Db, id: string) {
  const [h] = await db.select().from(hosts).where(eq(hosts.id, id));
  if (!h) throw new AppError("not_found", "Nem található.", 404);
  const ev = await loadEvent(db, h.eventId);
  return {
    id: h.id, contactName: h.contactName, email: h.email, pendingEmail: null as string | null, phone: h.phone, address: h.address, pickupMode: h.pickupMode,
    participantNote: h.participantNote, status: h.status, locationConfirmed: h.locationConfirmed,
    event: { id: ev.id, name: ev.name, status: ev.status, modificationDeadline: ev.modificationDeadline, plannedStart: ev.plannedStart },
    canModify: modificationAllowed(new Date(), ev.modificationDeadline, ev.status as EventStatus) && ["pending", "approved"].includes(h.status),
  };
}

/** Címváltozásnál újrageokódolás és újra jóváhagyás szükséges (a geokódolás az M3-ban jön; itt a pozíció törlődik). */
export async function updateHost(
  db: Db, cfg: Config, id: string,
  patch: Partial<{ contactName: string; phone: string; address: string; pickupMode: PickupMode; participantNote: string }>,
  adminId?: string,
) {
  const { row, ev } = await loadSubject(db, "host", id);
  assertParticipantEditable(ev, row.status, !!adminId);
  if (!adminId && patch.pickupMode !== undefined && ev.status === "active") throw new AppError("pickup_locked", "A felvételi mód az esemény közben nem módosítható.", 409);
  const h = row as typeof hosts.$inferSelect;
  const set: Partial<typeof hosts.$inferInsert> = { updatedAt: new Date() };
  if (patch.contactName !== undefined) set.contactName = patch.contactName.trim();
  if (patch.pickupMode !== undefined) set.pickupMode = patch.pickupMode;
  if (patch.participantNote !== undefined) set.participantNote = patch.participantNote.trim() || null;
  if (patch.phone !== undefined) {
    const p = normalizeHuPhone(patch.phone);
    if (!p) throw new AppError("invalid_phone", "Adj meg érvényes magyar telefonszámot.");
    set.phone = p;
  }
  let reapproval = false;
  if (patch.address !== undefined && normalizeAddress(patch.address) !== h.normalizedAddress) {
    Object.assign(set, {
      address: patch.address.trim(), normalizedAddress: normalizeAddress(patch.address),
      latitude: null, longitude: null, locationConfirmed: false, status: "pending",
    });
    reapproval = true;
  }
  try {
    await db.transaction(async (tx) => {
      await tx.update(hosts).set(set).where(eq(hosts.id, id));
      if (reapproval) await deactivateHostStation(tx, id, "address_changed");
      const fields = Object.keys(set).filter((k) => !["updatedAt", "normalizedAddress", "latitude", "longitude", "locationConfirmed"].includes(k));
      await audit(tx, { actorType: adminId ? "admin" : "host", actorId: adminId ?? id, action: "host.edit", entityType: "host", entityId: id, eventId: ev.id, after: { fields, reapproval, byAdmin: !!adminId } });
      if (reapproval) await notifyAdmins(tx, cfg, "Állomás címváltozás", "Egy állomás címe megváltozott, újra jóváhagyás szükséges.", `admin_host_addr:${id}:${Date.now()}`, ev.id);
    });
  } catch (e) {
    if (isUnique(e, "hosts_event_address_uq")) throw new AppError("address_taken", "Erre a címre már van jelentkezés ezen az eseményen.", 409);
    throw e;
  }
  return { reapprovalRequired: reapproval };
}

// ---------- E-mail cím módosítása ----------
export async function requestEmailChange(db: Db, cfg: Config, type: SubjectType, id: string, newEmail: string) {
  const { row, ev } = await loadSubject(db, type, id);
  assertParticipantEditable(ev, row.status);
  if (!(await hit(db, "email_change", id, 5, 3600))) throw new AppError("rate_limited", "Túl sok próbálkozás.", 429);
  const email = newEmail.trim().toLowerCase();
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.insert(participantTokens).values({
      purpose: "email_change", subjectType: type, subjectId: id, tokenHash: hashToken(token), newEmail: email, expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    });
    if (type === "team") await tx.update(teams).set({ pendingEmail: email }).where(eq(teams.id, id));
    await audit(tx, { actorType: type, actorId: id, action: `${type}.email_change_requested`, entityType: type, entityId: id, eventId: ev.id });
    await enqueueEmail(tx, cfg, {
      type: "email_change_confirm", recipient: email, data: { ...eventData(ev), role: type, link: `${cfg.PUBLIC_BASE_URL}/email-megerosites/${token}` },
      dedupKey: `email_change:${id}:${hashToken(token).slice(0, 12)}`, eventId: ev.id, entityType: type, entityId: id,
    });
  });
}

export async function confirmEmailChange(db: Db, token: string) {
  const [t] = await db.select().from(participantTokens).where(and(eq(participantTokens.tokenHash, hashToken(token)), eq(participantTokens.purpose, "email_change"), sql`${participantTokens.usedAt} is null`));
  if (!t || t.expiresAt < new Date() || !t.newEmail) throw new AppError("expired", "A link érvénytelen vagy lejárt.", 400);
  await db.transaction(async (tx) => {
    const type = t.subjectType as SubjectType;
    await tx.update(table(type)).set({ email: t.newEmail!, updatedAt: new Date(), ...(type === "team" ? { pendingEmail: null } : {}) } as never).where(eq(table(type).id, t.subjectId));
    await tx.update(participantTokens).set({ usedAt: new Date() }).where(eq(participantTokens.id, t.id));
    await audit(tx, { actorType: type, actorId: t.subjectId, action: `${type}.email_changed`, entityType: type, entityId: t.subjectId });
  });
}

// ---------- PIN helyreállítás ----------
/** Mindig sikeresnek tűnik; csak létező, jóváhagyott, élő hozzáférésnél készül levél. */
export async function requestPinRecovery(db: Db, cfg: Config, email: string, ip: string): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!(await hit(db, "pin_recovery_ip", ip, 10, 3600)) || !(await hit(db, "pin_recovery_email", addr, 3, 3600))) return;
  for (const type of ["team", "host"] as const) {
    const t = table(type);
    const rows = await db.select({ id: t.id, eventId: t.eventId }).from(t).where(and(sql`lower(${t.email}) = ${addr}`, eq(t.status, "approved")));
    for (const r of rows) {
      const [cred] = await db.select().from(accessCredentials).where(and(eq(accessCredentials.subjectType, type), eq(accessCredentials.subjectId, r.id), sql`${accessCredentials.revokedAt} is null`));
      if (!cred) continue;
      const ev = await loadEvent(db, r.eventId);
      const token = newToken();
      await db.transaction(async (tx) => {
        await tx.insert(participantTokens).values({ purpose: "pin_recovery", subjectType: type, subjectId: r.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + PIN_RECOVERY_TTL_MS) });
        await audit(tx, { actorType: "system", action: "access.pin_recovery_requested", entityType: type, entityId: r.id, eventId: ev.id });
        await enqueueEmail(tx, cfg, {
          type: "pin_recovery", recipient: addr, data: { ...eventData(ev), role: type, link: `${cfg.PUBLIC_BASE_URL}/pin-visszaallitas/${token}` },
          dedupKey: `pin_recovery:${r.id}:${hashToken(token).slice(0, 12)}`, eventId: ev.id, entityType: type, entityId: r.id,
        });
      });
    }
  }
}

export async function completePinRecovery(db: Db, token: string, pin: string, pinAgain: string) {
  if (pin !== pinAgain) throw new AppError("mismatch", "A két PIN nem egyezik.");
  const [t] = await db.select().from(participantTokens).where(and(eq(participantTokens.tokenHash, hashToken(token)), eq(participantTokens.purpose, "pin_recovery"), sql`${participantTokens.usedAt} is null`));
  if (!t || t.expiresAt < new Date()) throw new AppError("expired", "A link érvénytelen vagy lejárt.");
  try {
    await changePin(db, t.subjectType as SubjectType, t.subjectId, pin, { type: "system" });
  } catch (e) {
    if (e instanceof AccessError && e.code === "weak_pin") throw new AppError("weak_pin", e.message);
    throw e;
  }
  await db.update(participantTokens).set({ usedAt: new Date() }).where(eq(participantTokens.id, t.id));
  await audit(db, { actorType: "system", action: "access.pin_recovered", entityType: t.subjectType, entityId: t.subjectId });
}

/** Admin: csapat/host eltávolítása az eseményből (indok kötelező); hozzáférés azonnal megszűnik. */
export async function removeFromEvent(db: Db, adminId: string, type: SubjectType, id: string, reason: string) {
  if (!reason.trim()) throw new AppError("reason_required", "Az eltávolítás indoklása kötelező.");
  const { row, ev } = await loadSubject(db, type, id);
  if (["removed", "archived"].includes(row.status)) throw new AppError("bad_state", "Már el van távolítva.", 409);
  await db.transaction(async (tx) => {
    await tx.update(table(type)).set({ status: "removed", statusReason: reason, updatedAt: new Date() }).where(eq(table(type).id, id));
    await revokeAccess(tx as unknown as Db, { subjectType: type, subjectId: id });
    if (type === "host") await deactivateHostStation(tx, id, "host_removed");
    await audit(tx, { actorType: "admin", actorId: adminId, action: `${type}.remove`, entityType: type, entityId: id, eventId: ev.id, reason });
  });
}
