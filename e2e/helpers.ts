import { execSync } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { E2E } from "./playwright.config";

export const BASE = `http://localhost:${E2E.port}`;

/** Az első admin létrehozása ugyanazzal a paranccsal, amelyet az üzemeltető is használ. */
export function bootstrapAdmin(email: string): string {
  const out = execSync(`npx tsx src/scripts/bootstrapAdmin.ts ${email} "E2E Admin"`, {
    cwd: path.resolve(process.cwd(), "../apps/server"),
    env: { ...process.env, DATABASE_URL: E2E.db, APP_SECRET: E2E.secret, PUBLIC_BASE_URL: BASE },
  }).toString();
  const m = out.match(/(http:\/\/\S+activate\?token=\S+)/);
  if (!m) throw new Error("Nincs aktivációs link: " + out);
  return m[1]!;
}

export async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: E2E.db });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}

/** Datetime-local mező értéke Budapest idő szerint, a mostanihoz képest eltolva. */
export function localInput(offsetMs: number): string {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Date.now() + offsetMs));
  return s.replace(" ", "T");
}

/** A jóváhagyó e-mail törzsének visszafejtése az outboxból (a küldés előtt: SMTP nélkül a levél a sorban marad). */
// Ugyanaz az AES-256-GCM, mint a szerver lib/crypto.ts-ében (a teszt nem importálja a szerverkódot)
function decrypt(payload: string, secret: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv("aes-256-gcm", scryptSync(secret, "th-v2-static-salt", 32), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export async function approvalCredentials(recipient: string): Promise<{ link: string; pin: string }> {
  const rows = await dbQuery<{ body_enc: string }>("select body_enc from email_deliveries where type = 'approval' and recipient = $1 order by created_at desc limit 1", [recipient]);
  if (!rows[0]?.body_enc) throw new Error("Nincs jóváhagyó levél: " + recipient);
  const text = (JSON.parse(decrypt(rows[0].body_enc, E2E.secret)) as { text: string }).text;
  return { link: text.match(/(http:\/\/\S+\/belepes\/\S+)/)![1]!, pin: text.match(/PIN: (\d{6})/)![1]! };
}
