import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { revealAt, type EventStatus } from "@th/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { events, hosts, teamMembers, teams } from "../db/schema.js";
import { audit } from "./audit.js";
import { formatHu } from "./applications.js";
import { enqueueEmail } from "./outbox.js";

/**
 * Időalapú események – az adatbázisban tárolt időpontok alapján, idempotensen (a dedup kulcsok miatt
 * újraindítás vagy többszöri futás sem küld duplán):
 *  - jelentkezés automatikus lezárása a lezárási időpontban,
 *  - T−24 értesítés a T−24 előtt jóváhagyottaknak (egyszer),
 *  - végleges létszámok a hostoknak a módosítási határidő után.
 * Az esemény indítása/befejezése szándékosan kézi (az actual idő a mérvadó).
 */
export async function runScheduled(db: Db, cfg: Config, now = new Date()): Promise<void> {
  // 1) jelentkezés lezárása
  const toClose = await db.update(events).set({ status: "preparation", updatedAt: now })
    .where(and(eq(events.status, "registration_open"), lte(events.registrationClose, now))).returning({ id: events.id });
  for (const e of toClose) await audit(db, { actorType: "system", action: "event.registration_closed", entityType: "event", entityId: e.id, eventId: e.id });

  const live = await db.select().from(events).where(inArray(events.status, ["registration_open", "preparation", "active"]));
  for (const ev of live) {
    // 2) T−24 értesítés
    const at = revealAt(ev.plannedStart, ev.actualStart);
    if (now >= at && (ev.status as EventStatus) !== "active") {
      for (const kind of ["team", "host"] as const) {
        const t = kind === "team" ? teams : hosts;
        const rows = await db.select({ id: t.id, email: t.email }).from(t)
          .where(and(eq(t.eventId, ev.id), eq(t.status, "approved"), lte(t.approvedAt, at))); // csak a T−24 előtt jóváhagyottak
        for (const r of rows) {
          await enqueueEmail(db, cfg, {
            type: "t24", recipient: r.email, data: { eventName: ev.name, plannedStart: formatHu(ev.plannedStart), organizerContact: ev.organizerContact || undefined, role: kind },
            dedupKey: `t24:${kind}:${r.id}`, eventId: ev.id, entityType: kind, entityId: r.id,
          });
        }
      }
    }
    // 3) végleges létszámok a hostoknak
    if (now > ev.modificationDeadline) {
      const [c] = await db.select({
        children: sql<number>`count(*) filter (where ${teamMembers.category} = 'child')::int`, total: sql<number>`count(*)::int`,
      }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(and(eq(teams.eventId, ev.id), eq(teams.status, "approved")));
      const children = c?.children ?? 0;
      const adults = (c?.total ?? 0) - children;
      const hs = await db.select({ id: hosts.id, email: hosts.email }).from(hosts).where(and(eq(hosts.eventId, ev.id), eq(hosts.status, "approved")));
      for (const h of hs) {
        await enqueueEmail(db, cfg, {
          type: "host_final_counts", recipient: h.email, data: { eventName: ev.name, children, adults, organizerContact: ev.organizerContact || undefined },
          dedupKey: `host_final_counts:${h.id}`, eventId: ev.id, entityType: "host", entityId: h.id,
        });
      }
    }
  }
}
