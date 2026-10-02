import { and, eq, isNull, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { adminRecoveryCodes, adminSessions, adminTokens, admins } from "../db/schema.js";
import { decrypt, encrypt, hashSecret, hashToken, newRecoveryCode, newToken, verifySecret } from "../lib/crypto.js";
import { audit } from "./audit.js";
import { hit } from "./rateLimit.js";

// ±1 időlépés tűrés az óraeltérés miatt
authenticator.options = { window: 1 };

export class AuthError extends Error {
  constructor(public code: "invalid" | "rate_limited" | "locked" | "weak_password" | "expired", message: string) {
    super(message);
  }
}

const INVITE_TTL_MS = 72 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;
export const ADMIN_SESSION_IDLE_MS = 8 * 3600_000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

export function validatePassword(pw: string): boolean {
  return pw.length >= 12 && /[a-zA-Z]/.test(pw) && /\d/.test(pw);
}

async function issueToken(db: Db, adminId: string, kind: "invitation" | "password_reset", ttl: number) {
  const token = newToken();
  await db.insert(adminTokens).values({
    adminId, kind, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttl),
  });
  return token;
}

/** Új admin meghívása (az e-mail kiküldése az outboxon át történik, M2). Visszaadja a link tokenjét. */
export async function inviteAdmin(db: Db, inviterId: string | null, email: string, displayName: string) {
  const [existing] = await db.select().from(admins).where(sql`lower(${admins.email}) = ${email.toLowerCase()}`);
  if (existing && existing.status !== "invited") throw new AuthError("invalid", "Ezzel az e-mail címmel már létezik admin.");
  const admin =
    existing ?? (await db.insert(admins).values({ email, displayName }).returning())[0]!;
  const token = await issueToken(db, admin.id, "invitation", INVITE_TTL_MS);
  await audit(db, {
    actorType: inviterId ? "admin" : "system", actorId: inviterId,
    action: "admin.invite", entityType: "admin", entityId: admin.id,
  });
  return { adminId: admin.id, token };
}

async function loadToken(db: Db, token: string, kind: "invitation" | "password_reset") {
  const [row] = await db.select().from(adminTokens)
    .where(and(eq(adminTokens.tokenHash, hashToken(token)), eq(adminTokens.kind, kind), isNull(adminTokens.usedAt)));
  if (!row || row.expiresAt < new Date()) throw new AuthError("expired", "A link érvénytelen vagy lejárt.");
  return row;
}

/** Aktiváció 1. lépés: TOTP secret generálása (még nem megerősített). */
export async function beginActivation(db: Db, cfg: Config, token: string) {
  const t = await loadToken(db, token, "invitation");
  const [admin] = await db.select().from(admins).where(eq(admins.id, t.adminId));
  if (!admin) throw new AuthError("invalid", "Ismeretlen admin.");
  const secret = authenticator.generateSecret();
  await db.update(admins).set({ totpSecretEnc: encrypt(secret, cfg.APP_SECRET), totpConfirmed: false })
    .where(eq(admins.id, admin.id));
  return { secret, otpauthUrl: authenticator.keyuri(admin.email, "Kincsvadászat", secret) };
}

/** Aktiváció 2. lépés: jelszó + első TOTP kód; visszaad egyszer használatos helyreállító kódokat. */
export async function completeActivation(db: Db, cfg: Config, token: string, password: string, totpCode: string) {
  if (!validatePassword(password)) throw new AuthError("weak_password", "A jelszó legalább 12 karakter, betűt és számot is tartalmazzon.");
  const t = await loadToken(db, token, "invitation");
  const [admin] = await db.select().from(admins).where(eq(admins.id, t.adminId));
  if (!admin?.totpSecretEnc) throw new AuthError("invalid", "Előbb kezdd el a 2FA beállítást.");
  if (!authenticator.check(totpCode, decrypt(admin.totpSecretEnc, cfg.APP_SECRET))) {
    throw new AuthError("invalid", "Hibás hitelesítő kód.");
  }
  const codes = Array.from({ length: 8 }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.update(admins).set({
      passwordHash: await hashSecret(password), totpConfirmed: true, status: "active",
    }).where(eq(admins.id, admin.id));
    await tx.update(adminTokens).set({ usedAt: new Date() }).where(eq(adminTokens.id, t.id));
    await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.adminId, admin.id));
    for (const c of codes) {
      await tx.insert(adminRecoveryCodes).values({ adminId: admin.id, codeHash: hashToken(c) });
    }
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "admin.activate", entityType: "admin", entityId: admin.id });
  });
  return { recoveryCodes: codes };
}

export interface LoginResult { sessionToken: string; csrfToken: string; adminId: string }

/** Admin belépés: jelszó + TOTP vagy helyreállító kód. Minden kimenet általános hibát ad. */
export async function adminLogin(
  db: Db, cfg: Config,
  input: { email: string; password: string; totp?: string; recoveryCode?: string },
  ip: string,
): Promise<LoginResult> {
  const generic = new AuthError("invalid", "Hibás e-mail, jelszó vagy hitelesítő kód.");
  if (!(await hit(db, "admin_login_ip", ip, 20, 900)) || !(await hit(db, "admin_login_email", input.email.toLowerCase(), 10, 900))) {
    throw new AuthError("rate_limited", "Túl sok próbálkozás. Próbáld újra később.");
  }
  const [admin] = await db.select().from(admins).where(sql`lower(${admins.email}) = ${input.email.toLowerCase()}`);
  const fail = async (actorId: string | null) => {
    await audit(db, { actorType: "admin", actorId, action: "admin.login_failed" });
    throw generic;
  };
  if (!admin || admin.status !== "active" || !admin.passwordHash || !admin.totpSecretEnc) return fail(null);
  if (admin.lockedUntil && admin.lockedUntil > new Date()) throw new AuthError("locked", "A fiók átmenetileg zárolva van.");

  let ok = await verifySecret(admin.passwordHash, input.password);
  let usedRecovery = false;
  if (ok) {
    if (input.recoveryCode) {
      const [rc] = await db.select().from(adminRecoveryCodes).where(and(
        eq(adminRecoveryCodes.adminId, admin.id),
        eq(adminRecoveryCodes.codeHash, hashToken(input.recoveryCode.trim().toUpperCase())),
        isNull(adminRecoveryCodes.usedAt),
      ));
      if (rc) {
        await db.update(adminRecoveryCodes).set({ usedAt: new Date() }).where(eq(adminRecoveryCodes.id, rc.id));
        usedRecovery = true;
      } else ok = false;
    } else {
      ok = !!input.totp && authenticator.check(input.totp, decrypt(admin.totpSecretEnc, cfg.APP_SECRET));
    }
  }
  if (!ok) {
    const failed = admin.failedLogins + 1;
    await db.update(admins).set({
      failedLogins: failed >= MAX_FAILED ? 0 : failed,
      lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null,
    }).where(eq(admins.id, admin.id));
    return fail(admin.id);
  }
  await db.update(admins).set({ failedLogins: 0, lockedUntil: null }).where(eq(admins.id, admin.id));
  const sessionToken = newToken();
  const csrfToken = newToken(16);
  await db.insert(adminSessions).values({
    adminId: admin.id, tokenHash: hashToken(sessionToken), csrfToken,
    expiresAt: new Date(Date.now() + ADMIN_SESSION_IDLE_MS),
  });
  await audit(db, { actorType: "admin", actorId: admin.id, action: "admin.login" });
  if (usedRecovery) await audit(db, { actorType: "admin", actorId: admin.id, action: "admin.2fa_recovery_used", entityType: "admin", entityId: admin.id });
  return { sessionToken, csrfToken, adminId: admin.id };
}

/** Session ellenőrzés; csúsztatja a lejáratot (idle timeout). */
export async function getAdminSession(db: Db, token: string | undefined) {
  if (!token) return null;
  const [s] = await db.select().from(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token)));
  if (!s || s.expiresAt < new Date()) return null;
  const [admin] = await db.select().from(admins).where(eq(admins.id, s.adminId));
  if (!admin || admin.status !== "active") return null;
  await db.update(adminSessions).set({
    lastSeenAt: new Date(), expiresAt: new Date(Date.now() + ADMIN_SESSION_IDLE_MS),
  }).where(eq(adminSessions.id, s.id));
  return { session: s, admin };
}

export async function adminLogout(db: Db, token: string, adminId: string) {
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token)));
  await audit(db, { actorType: "admin", actorId: adminId, action: "admin.logout" });
}

/** Jelszó-visszaállítás kérése: mindig általános válasz; token csak létező, aktív adminnak készül. */
export async function requestPasswordReset(db: Db, email: string, ip: string): Promise<{ adminId: string; token: string } | null> {
  if (!(await hit(db, "pw_reset_ip", ip, 5, 3600)) || !(await hit(db, "pw_reset_email", email.toLowerCase(), 3, 3600))) return null;
  const [admin] = await db.select().from(admins).where(sql`lower(${admins.email}) = ${email.toLowerCase()}`);
  if (!admin || admin.status !== "active") return null;
  const token = await issueToken(db, admin.id, "password_reset", RESET_TTL_MS);
  await audit(db, { actorType: "system", action: "admin.password_reset_requested", entityType: "admin", entityId: admin.id });
  return { adminId: admin.id, token };
}

export async function completePasswordReset(db: Db, token: string, newPassword: string) {
  if (!validatePassword(newPassword)) throw new AuthError("weak_password", "A jelszó legalább 12 karakter, betűt és számot is tartalmazzon.");
  const t = await loadToken(db, token, "password_reset");
  await db.transaction(async (tx) => {
    await tx.update(admins).set({ passwordHash: await hashSecret(newPassword), failedLogins: 0, lockedUntil: null }).where(eq(admins.id, t.adminId));
    await tx.update(adminTokens).set({ usedAt: new Date() }).where(eq(adminTokens.id, t.id));
    await tx.delete(adminSessions).where(eq(adminSessions.adminId, t.adminId));
    await audit(tx, { actorType: "admin", actorId: t.adminId, action: "admin.password_reset", entityType: "admin", entityId: t.adminId });
  });
}

/** Archiválás (nincs törlés, nincs külön disable). Az auditrekordok az adminhoz tartozva maradnak. */
export async function setAdminArchived(db: Db, actorId: string, targetId: string, archived: boolean) {
  if (archived && actorId === targetId) throw new AuthError("invalid", "Saját magadat nem archiválhatod.");
  await db.transaction(async (tx) => {
    await tx.update(admins).set({
      status: archived ? "archived" : "active", archivedAt: archived ? new Date() : null,
    }).where(eq(admins.id, targetId));
    if (archived) await tx.delete(adminSessions).where(eq(adminSessions.adminId, targetId));
    await audit(tx, {
      actorType: "admin", actorId, action: archived ? "admin.archive" : "admin.restore",
      entityType: "admin", entityId: targetId,
    });
  });
}
