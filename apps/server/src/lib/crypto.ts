import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

/** 256 bites véletlen token (base64url). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Token hash-elt tárolásra; a token nagy entrópiájú, ezért elég a gyors SHA-256. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Egyszer használatos helyreállító kód, pl. "K7QF-92MD". */
export function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => alphabet[randomInt(alphabet.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

// Titkosítás (pl. TOTP secret, SMTP jelszó) az APP_SECRET-ből származtatott kulccsal
function key(secret: string): Buffer {
  return scryptSync(secret, "th-v2-static-salt", 32);
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string, secret: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv("aes-256-gcm", key(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
