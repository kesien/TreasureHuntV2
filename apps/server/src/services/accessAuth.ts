import { and, eq, isNull } from "drizzle-orm";
import { validatePin } from "@th/shared";
import type { Db } from "../db/client.js";
import { accessCredentials, accessSessions } from "../db/schema.js";
import { hashSecret, hashToken, newToken, verifySecret } from "../lib/crypto.js";
import { audit } from "./audit.js";
import { hit } from "./rateLimit.js";

export type SubjectType = "team" | "host";
const MAX_FAILED = 5;
const LOCK_MS = 10 * 60_000;

export class AccessError extends Error {
  constructor(public code: "invalid" | "rate_limited" | "weak_pin" | "revoked", message: string) {
    super(message);
  }
}

/** Jóváhagyáskor: hozzáférés létrehozása. A link tokent és a PIN-t csak most látjuk nyersen (e-mailhez). */
export async function createCredential(
  db: Db, subjectType: SubjectType, subjectId: string, eventId: string, pin: string,
) {
  const check = validatePin(pin);
  if (!check.ok) throw new AccessError("weak_pin", "A PIN legyen 6 számjegy, és ne legyen triviális.");
  const token = newToken();
  await db.insert(accessCredentials).values({
    subjectType, subjectId, eventId, tokenHash: hashToken(token), pinHash: await hashSecret(pin),
  });
  return { token };
}

/** Belépés linktoken + PIN-nel. Új, eszközönkénti session. Általános hiba, hogy a link ne legyen kitalálható. */
export async function accessLogin(db: Db, token: string, pin: string, ip: string, userAgent?: string) {
  const generic = new AccessError("invalid", "Hibás link vagy PIN.");
  if (!(await hit(db, "access_login_ip", ip, 30, 900))) throw new AccessError("rate_limited", "Túl sok próbálkozás. Próbáld újra később.");
  const [cred] = await db.select().from(accessCredentials)
    .where(and(eq(accessCredentials.tokenHash, hashToken(token)), isNull(accessCredentials.revokedAt)));
  if (!cred) throw generic;
  if (cred.lockedUntil && cred.lockedUntil > new Date()) throw new AccessError("rate_limited", "Túl sok hibás PIN. Próbáld újra később.");
  if (!(await verifySecret(cred.pinHash, pin))) {
    const failed = cred.failedAttempts + 1;
    await db.update(accessCredentials).set({
      failedAttempts: failed >= MAX_FAILED ? 0 : failed,
      lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null,
    }).where(eq(accessCredentials.id, cred.id));
    throw generic;
  }
  await db.update(accessCredentials).set({ failedAttempts: 0, lockedUntil: null }).where(eq(accessCredentials.id, cred.id));
  const sessionToken = newToken();
  const csrfToken = newToken(16);
  await db.insert(accessSessions).values({
    credentialId: cred.id, tokenHash: hashToken(sessionToken), csrfToken, userAgent: userAgent?.slice(0, 200),
  });
  return { sessionToken, csrfToken, subjectType: cred.subjectType as SubjectType, subjectId: cred.subjectId, eventId: cred.eventId };
}

export async function getAccessSession(db: Db, token: string | undefined) {
  if (!token) return null;
  const [s] = await db.select().from(accessSessions).where(eq(accessSessions.tokenHash, hashToken(token)));
  if (!s) return null;
  const [cred] = await db.select().from(accessCredentials).where(eq(accessCredentials.id, s.credentialId));
  if (!cred || cred.revokedAt) return null;
  await db.update(accessSessions).set({ lastSeenAt: new Date() }).where(eq(accessSessions.id, s.id));
  return { session: s, credential: cred };
}

/** Csak az aktuális eszköz kilépése. */
export async function accessLogout(db: Db, token: string) {
  await db.delete(accessSessions).where(eq(accessSessions.tokenHash, hashToken(token)));
}

/** PIN csere: minden session azonnal érvénytelen. */
export async function changePin(db: Db, subjectType: SubjectType, subjectId: string, newPin: string, actor: { type: "team" | "host" | "admin" | "system"; id?: string }) {
  const check = validatePin(newPin);
  if (!check.ok) throw new AccessError("weak_pin", "A PIN legyen 6 számjegy, és ne legyen triviális.");
  await db.transaction(async (tx) => {
    const [cred] = await tx.update(accessCredentials)
      .set({ pinHash: await hashSecret(newPin), failedAttempts: 0, lockedUntil: null })
      .where(and(eq(accessCredentials.subjectType, subjectType), eq(accessCredentials.subjectId, subjectId)))
      .returning();
    if (!cred) throw new AccessError("invalid", "Nincs hozzáférés ehhez a szereplőhöz.");
    await tx.delete(accessSessions).where(eq(accessSessions.credentialId, cred.id));
    await audit(tx, { actorType: actor.type, actorId: actor.id, action: "access.pin_change", entityType: subjectType, entityId: subjectId });
  });
}

/** Link újragenerálása: régi azonnal érvénytelen; PIN és meglévő sessionök maradnak. */
export async function regenerateLink(db: Db, subjectType: SubjectType, subjectId: string, actorId: string) {
  const token = newToken();
  const [cred] = await db.update(accessCredentials).set({ tokenHash: hashToken(token) })
    .where(and(eq(accessCredentials.subjectType, subjectType), eq(accessCredentials.subjectId, subjectId)))
    .returning();
  if (!cred) throw new AccessError("invalid", "Nincs hozzáférés ehhez a szereplőhöz.");
  await audit(db, { actorType: "admin", actorId, action: "access.link_regenerated", entityType: subjectType, entityId: subjectId });
  return { token };
}

/** Hozzáférés lezárása (visszalépés, eltávolítás, esemény törlése/lejárta). */
export async function revokeAccess(db: Db, where: { subjectType?: SubjectType; subjectId?: string; eventId?: string }) {
  const conds = [isNull(accessCredentials.revokedAt)];
  if (where.subjectType) conds.push(eq(accessCredentials.subjectType, where.subjectType));
  if (where.subjectId) conds.push(eq(accessCredentials.subjectId, where.subjectId));
  if (where.eventId) conds.push(eq(accessCredentials.eventId, where.eventId));
  const revoked = await db.update(accessCredentials).set({ revokedAt: new Date() }).where(and(...conds)).returning();
  for (const c of revoked) await db.delete(accessSessions).where(eq(accessSessions.credentialId, c.id));
  return revoked.length;
}
