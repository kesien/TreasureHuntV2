import type { Db, Tx } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

export interface AuditEntry {
  actorType: "admin" | "team" | "host" | "system";
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  eventId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  correlationId?: string;
}

// Jelszó/PIN/token jellegű mezők sosem kerülhetnek az auditba.
const SENSITIVE = /pin|password|token|secret|hash|totp|recovery/i;

function scrub(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrub);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !SENSITIVE.test(k))
      .map(([k, v]) => [k, scrub(v)]),
  );
}

export async function audit(db: Db | Tx, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    eventId: e.eventId ?? null,
    before: e.before === undefined ? null : scrub(e.before),
    after: e.after === undefined ? null : scrub(e.after),
    reason: e.reason ?? null,
    correlationId: e.correlationId ?? null,
  });
}
