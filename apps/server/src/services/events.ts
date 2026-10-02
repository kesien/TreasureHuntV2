import { eq, sql } from "drizzle-orm";
import { canTransition, validateEventDates, type EventStatus } from "@th/shared";
import type { Db } from "../db/client.js";
import { events, hosts, teams } from "../db/schema.js";
import { pgError } from "../lib/dbError.js";
import { audit } from "./audit.js";
import { revokeAccess } from "./accessAuth.js";
import { enqueueEmail } from "./outbox.js";
import type { Config } from "../config.js";

export class EventError extends Error {
  constructor(public code: "not_found" | "invalid" | "conflict", message: string, public details?: string[]) {
    super(message);
  }
}

export interface EventInput {
  name: string;
  type: "halloween" | "easter";
  shortDescription?: string;
  rules?: string;
  registrationStart: Date;
  registrationClose: Date;
  modificationDeadline: Date;
  plannedStart: Date;
  plannedEnd: Date;
  checkinRadiusM?: number;
  organizerContact?: string;
}

export async function createEvent(db: Db, adminId: string, input: EventInput) {
  const errs = validateEventDates(input);
  if (errs.length) throw new EventError("invalid", "Hibás dátumok.", errs);
  const [ev] = await db.insert(events).values({ ...input, status: "draft" }).returning();
  await audit(db, { actorType: "admin", actorId: adminId, action: "event.create", entityType: "event", entityId: ev!.id, eventId: ev!.id, after: ev });
  return ev!;
}

export async function getEvent(db: Db, id: string) {
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  if (!ev) throw new EventError("not_found", "Az esemény nem található.");
  return ev;
}

/** Szerkesztés. Figyelmeztetéseket ad vissza, ha a módosítás a résztvevőket érintheti (spec §99). */
export async function updateEvent(db: Db, adminId: string, id: string, patch: Partial<EventInput>) {
  const before = await getEvent(db, id);
  if (before.status === "closed" || before.status === "cancelled") throw new EventError("conflict", "Lezárt esemény nem módosítható.");
  const merged = { ...before, ...patch };
  const errs = validateEventDates(merged);
  if (errs.length) throw new EventError("invalid", "Hibás dátumok.", errs);
  const warnings: string[] = [];
  if (before.status !== "draft") {
    if (patch.registrationClose || patch.registrationStart) warnings.push("A jelentkezési időszak módosítása már nyitott eseménynél a jelentkezőket érinti.");
    if (patch.modificationDeadline) warnings.push("A módosítási határidő változása a résztvevők szerkesztési lehetőségét érinti.");
    if (patch.plannedStart) warnings.push("A kezdés módosítása a T−24 helyszín-felfedés időpontját is módosítja.");
    if (patch.checkinRadiusM) warnings.push("A check-in sugár módosítása az érkezések ellenőrzését érinti.");
  }
  const [after] = await db.update(events).set({ ...patch, updatedAt: new Date() }).where(eq(events.id, id)).returning();
  await audit(db, { actorType: "admin", actorId: adminId, action: "event.edit", entityType: "event", entityId: id, eventId: id, before, after });
  return { event: after!, warnings };
}

/**
 * Életciklus-átmenet. Start: függő jelentkezések lejárnak. Lezárás: hozzáférés 7 napig él (a lejáratot
 * a worker kezeli). Törlés/cancel: azonnali hozzáférés-visszavonás, indok kötelező ha volt jelentkező.
 */
export async function transitionEvent(db: Db, adminId: string, id: string, to: EventStatus, reason?: string, cfg?: Config) {
  const ev = await getEvent(db, id);
  if (!canTransition(ev.status as EventStatus, to)) {
    throw new EventError("conflict", `Az átmenet nem engedélyezett: ${ev.status} → ${to}.`);
  }
  if (to === "cancelled" && !reason?.trim()) throw new EventError("invalid", "A lemondás indoklása kötelező.");
  let expired = 0;
  const updated = await db.transaction(async (tx) => {
    const patch: Partial<typeof events.$inferInsert> = { status: to, updatedAt: new Date() };
    if (to === "active") {
      patch.actualStart = new Date();
      for (const t of [teams, hosts] as const) {
        const rows = await tx.update(t).set({ status: "expired", updatedAt: new Date() })
          .where(sql`${t.eventId} = ${id} and ${t.status} = 'pending'`).returning({ id: t.id });
        expired += rows.length;
      }
    }
    if (to === "closed") patch.actualEnd = new Date();
    if (to === "cancelled") patch.cancellationReason = reason;
    try {
      const [row] = await tx.update(events).set(patch).where(eq(events.id, id)).returning();
      if (cfg && (to === "active" || to === "cancelled")) {
        // Értesítés a résztvevőknek (a lemondásnál a függőknek is); az indításkor lejárt jelentkezők nem kapnak "elindult" levelet
        const statuses = to === "active" ? ["approved"] : ["approved", "pending"];
        for (const kind of ["team", "host"] as const) {
          const t = kind === "team" ? teams : hosts;
          const rows = await tx.select({ id: t.id, email: t.email }).from(t).where(sql`${t.eventId} = ${id} and ${t.status} in (${sql.join(statuses.map((x) => sql`${x}`), sql`, `)})`);
          for (const r of rows) {
            await enqueueEmail(tx, cfg, {
              type: to === "active" ? "event_started" : "event_cancellation", recipient: r.email, data: { eventName: ev.name, reason, organizerContact: ev.organizerContact || undefined },
              dedupKey: `${to}:${kind}:${r.id}`, eventId: id, entityType: kind, entityId: r.id,
            });
          }
        }
      }
      await audit(tx, {
        actorType: "admin", actorId: adminId, action: `event.${to}`, entityType: "event", entityId: id, eventId: id,
        before: { status: ev.status }, after: { status: to, expiredApplications: expired }, reason,
      });
      return row!;
    } catch (e) {
      if (pgError(e).constraint === "events_single_active_uq") {
        throw new EventError("conflict", "Már van aktív esemény.");
      }
      throw e;
    }
  });
  if (to === "cancelled") await revokeAccess(db, { eventId: id });
  return { event: updated, expiredApplications: expired };
}

/** Üres draft fizikailag törölhető; ha volt jelentkező, csak lemondani lehet. */
export async function deleteEmptyDraft(db: Db, adminId: string, id: string) {
  const ev = await getEvent(db, id);
  if (ev.status !== "draft") throw new EventError("conflict", "Csak draft esemény törölhető.");
  const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.eventId, id));
  const [h] = await db.select({ n: sql<number>`count(*)::int` }).from(hosts).where(eq(hosts.eventId, id));
  if ((t?.n ?? 0) + (h?.n ?? 0) > 0) throw new EventError("conflict", "Volt jelentkező, ezért az esemény nem törölhető, csak lemondható.");
  await db.delete(events).where(eq(events.id, id));
  await audit(db, { actorType: "admin", actorId: adminId, action: "event.delete", entityType: "event", entityId: id, before: ev });
}

export async function listEvents(db: Db) {
  return db.select().from(events).orderBy(sql`${events.plannedStart} desc`);
}
