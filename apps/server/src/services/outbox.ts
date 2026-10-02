import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/client.js";
import { admins, emailDeliveries } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { audit } from "./audit.js";
import type { MailTransport } from "./mailer.js";
import { SENSITIVE_TYPES, buildContent, render, type EmailType, type TemplateData } from "./templates.js";

export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60, 180]; // percek az egymást követő próbák között

export interface EnqueueInput {
  type: EmailType;
  recipient: string;
  data: TemplateData;
  /** Deduplikáció: azonos kulcs másodszor nem kerül sorba (recipient + type + entity + event). */
  dedupKey?: string;
  eventId?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Sorba állítás. A hívó tranzakciójában fut, a tényleges küldés külön (worker) – így az e-mail hibája
 * sosem töröl adatot. Igaz, ha új sor jött létre.
 */
export async function enqueueEmail(db: Db | Tx, cfg: Config, e: EnqueueInput): Promise<boolean> {
  const content = buildContent(e.type, e.data);
  const { html, text } = render(content);
  const rows = await db.insert(emailDeliveries).values({
    type: e.type, recipient: e.recipient.toLowerCase(), subject: content.subject,
    bodyEnc: encrypt(JSON.stringify({ html, text }), cfg.APP_SECRET),
    sensitive: SENSITIVE_TYPES.has(e.type),
    dedupKey: e.dedupKey ?? null, eventId: e.eventId, entityType: e.entityType, entityId: e.entityId,
  }).onConflictDoNothing({ target: emailDeliveries.dedupKey }).returning({ id: emailDeliveries.id });
  return rows.length > 0;
}

/** Értesítés minden aktív adminnak (admin-szintű dedup kulccsal). */
export async function notifyAdmins(db: Db | Tx, cfg: Config, subject: string, message: string, dedupBase: string, eventId?: string) {
  const list = await db.select({ id: admins.id, email: admins.email }).from(admins).where(eq(admins.status, "active"));
  for (const a of list) {
    await enqueueEmail(db, cfg, {
      type: "admin_notice", recipient: a.email, data: { subjectName: subject, message },
      dedupKey: `${dedupBase}:${a.id}`, eventId,
    });
  }
}

/** Esedékes levelek feldolgozása. A sorokat zárolja, így több worker sem küld duplán. */
export async function processDue(db: Db, cfg: Config, transport: MailTransport, limit = 20): Promise<number> {
  const due = await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      select id from email_deliveries
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at limit ${limit} for update skip locked`);
    return (res.rows as Array<{ id: string }>).map((r) => r.id);
  });
  let sent = 0;
  for (const id of due) {
    const [row] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.id, id), eq(emailDeliveries.status, "pending")));
    if (!row || !row.bodyEnc) continue;
    const body = JSON.parse(decrypt(row.bodyEnc, cfg.APP_SECRET)) as { html: string; text: string };
    try {
      await transport.send({ to: row.recipient, subject: row.subject, ...body });
      await db.update(emailDeliveries).set({
        status: "sent", sentAt: new Date(), attempts: row.attempts + 1, lastAttemptAt: new Date(), lastError: null,
        bodyEnc: row.sensitive ? null : row.bodyEnc, // érzékeny törzs eltávolítása küldés után
      }).where(eq(emailDeliveries.id, id));
      sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const delayMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]!;
      await db.update(emailDeliveries).set({
        status: failed ? "failed" : "pending", attempts, lastAttemptAt: new Date(),
        nextAttemptAt: new Date(Date.now() + delayMin * 60_000),
        lastError: String((err as Error).message ?? err).slice(0, 200), // rövid ok, részletek nélkül
      }).where(eq(emailDeliveries.id, id));
    }
  }
  return sent;
}

export class ResendError extends Error {
  constructor(public code: "not_found" | "rate_limited" | "not_resendable", message: string) { super(message); }
}

/**
 * Kézi újraküldés. Ugyanaz a címzett + típus percenként legfeljebb egyszer. Érzékeny levelet (link/PIN),
 * aminek a törzse már törölve van, nem lehet így újraküldeni – új hozzáférést kell kiadni.
 */
export async function manualResend(db: Db, adminId: string, id: string) {
  const [row] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, id));
  if (!row) throw new ResendError("not_found", "A levél nem található.");
  if (!row.bodyEnc) throw new ResendError("not_resendable", "Érzékeny tartalma miatt ez a levél nem küldhető újra; adj ki új hozzáférést.");
  const since = new Date(Date.now() - 60_000);
  const [recent] = await db.select({ n: sql<number>`count(*)::int` }).from(emailDeliveries).where(and(
    eq(emailDeliveries.recipient, row.recipient), eq(emailDeliveries.type, row.type),
    sql`coalesce(${emailDeliveries.lastResendAt}, 'epoch') > ${since}`,
  ));
  if ((recent?.n ?? 0) > 0) throw new ResendError("rate_limited", "Percenként legfeljebb egyszer küldhető újra.");
  await db.update(emailDeliveries).set({
    status: "pending", attempts: 0, nextAttemptAt: new Date(), lastResendAt: new Date(), resendCount: row.resendCount + 1,
  }).where(eq(emailDeliveries.id, id));
  await audit(db, { actorType: "admin", actorId: adminId, action: "email.resend", entityType: "email", entityId: id });
}

export async function listDeliveries(db: Db, limit = 100) {
  return db.select({
    id: emailDeliveries.id, type: emailDeliveries.type, recipient: emailDeliveries.recipient, subject: emailDeliveries.subject,
    status: emailDeliveries.status, attempts: emailDeliveries.attempts, resendCount: emailDeliveries.resendCount,
    lastAttemptAt: emailDeliveries.lastAttemptAt, lastError: emailDeliveries.lastError, sentAt: emailDeliveries.sentAt,
    createdAt: emailDeliveries.createdAt,
  }).from(emailDeliveries).orderBy(desc(emailDeliveries.createdAt)).limit(limit);
}

/** Ütemezett újrapróbálás jelzése a lejárt várakozókhoz nem kell: a processDue a nextAttemptAt alapján dolgozik. */
export async function dueCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(emailDeliveries)
    .where(and(eq(emailDeliveries.status, "pending"), lte(emailDeliveries.nextAttemptAt, new Date())));
  return r?.n ?? 0;
}
