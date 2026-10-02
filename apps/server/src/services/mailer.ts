import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";

export interface OutgoingMail { to: string; subject: string; html: string; text: string }
export interface MailTransport { send(m: OutgoingMail): Promise<void> }

export interface SmtpSettings {
  host: string; port: number; secure: boolean; username: string; password: string;
  senderName: string; senderEmail: string;
}

/** SMTP beállítások mentése; a jelszó titkosítva kerül az adatbázisba. */
export async function saveSmtp(db: Db, cfg: Config, s: SmtpSettings) {
  const value = { ...s, password: encrypt(s.password, cfg.APP_SECRET) };
  await db.insert(settings).values({ key: "smtp", value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function loadSmtp(db: Db, cfg: Config): Promise<SmtpSettings | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "smtp"));
  if (!row) return null;
  const v = row.value as SmtpSettings;
  return { ...v, password: v.password ? decrypt(v.password, cfg.APP_SECRET) : "" };
}

/** A beállított SMTP szerveren küld; ha nincs beállítás, hibát dob (az outbox újrapróbálja). */
export function smtpTransport(db: Db, cfg: Config): MailTransport {
  return {
    async send(m) {
      const s = await loadSmtp(db, cfg);
      if (!s) throw new Error("Az SMTP nincs beállítva.");
      const t = nodemailer.createTransport({
        host: s.host, port: s.port, secure: s.secure,
        auth: s.username ? { user: s.username, pass: s.password } : undefined,
        connectionTimeout: 10_000, socketTimeout: 20_000,
      });
      await t.sendMail({ from: { name: s.senderName, address: s.senderEmail }, to: m.to, subject: m.subject, html: m.html, text: m.text });
    },
  };
}
