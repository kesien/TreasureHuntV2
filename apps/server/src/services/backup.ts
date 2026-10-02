import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { backupRuns, events } from "../db/schema.js";
import { audit } from "./audit.js";

/** Mentést végző komponens – cserélhető (teszt, más célhely). A DB és a fotók külön fájlba kerülnek. */
export interface BackupRunner {
  dumpDatabase(databaseUrl: string, outFile: string): Promise<void>;
  archiveDirectory(dir: string, outFile: string): Promise<void>;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += String(d).slice(0, 500); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} kilépési kód: ${code} ${err.slice(0, 200)}`))));
  });
}

/** Alapértelmezett: pg_dump (custom formátum) és tar.gz. A jelszó környezeti változón megy, nem a parancssoron. */
export class DefaultBackupRunner implements BackupRunner {
  async dumpDatabase(databaseUrl: string, outFile: string) {
    const u = new URL(databaseUrl);
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
    await run("pg_dump", ["--format=custom", "--no-owner", "-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", u.pathname.slice(1), "-f", outFile], env);
  }
  async archiveDirectory(dir: string, outFile: string) {
    await mkdir(dir, { recursive: true });
    await run("tar", ["-czf", outFile, "-C", dir, "."]);
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

/** Egy mentés futtatása; az eredmény (siker/hiba) mindig rögzül. A kimenetet a BACKUP_DIR alá írja. */
export async function runBackup(db: Db, cfg: Config, runner: BackupRunner, kind: "daily" | "manual" | "event_snapshot", opts: { eventId?: string; actorId?: string } = {}) {
  const [row] = await db.insert(backupRuns).values({ kind, eventId: opts.eventId ?? null }).returning();
  const base = path.resolve(cfg.BACKUP_DIR, kind === "event_snapshot" ? "snapshots" : "daily");
  const name = `${kind}-${opts.eventId ? opts.eventId.slice(0, 8) + "-" : ""}${stamp(row!.startedAt)}`;
  const dbFile = path.join(base, `${name}.db.dump`);
  const photosFile = path.join(base, `${name}.photos.tar.gz`);
  try {
    await mkdir(base, { recursive: true });
    await runner.dumpDatabase(cfg.DATABASE_URL, dbFile);
    await runner.archiveDirectory(path.resolve(cfg.PHOTO_DIR), photosFile);
    const bytes = (await stat(dbFile)).size + (await stat(photosFile)).size;
    await db.update(backupRuns).set({ status: "ok", dbFile, photosFile, bytes, finishedAt: new Date() }).where(eq(backupRuns.id, row!.id));
    if (opts.actorId) await audit(db, { actorType: "admin", actorId: opts.actorId, action: "backup.manual", entityType: "backup", entityId: row!.id });
    return { id: row!.id, status: "ok" as const };
  } catch (e) {
    await db.update(backupRuns).set({ status: "failed", error: String((e as Error).message).slice(0, 300), finishedAt: new Date() }).where(eq(backupRuns.id, row!.id));
    await rm(dbFile, { force: true });
    await rm(photosFile, { force: true });
    return { id: row!.id, status: "failed" as const };
  }
}

export async function lastBackups(db: Db) {
  const [lastOk] = await db.select().from(backupRuns).where(eq(backupRuns.status, "ok")).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [last] = await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(1);
  return { lastOk: lastOk ?? null, last: last ?? null };
}

export async function listBackupRuns(db: Db, limit = 30) {
  return db.select({
    id: backupRuns.id, kind: backupRuns.kind, status: backupRuns.status, bytes: backupRuns.bytes, error: backupRuns.error,
    startedAt: backupRuns.startedAt, finishedAt: backupRuns.finishedAt, eventId: backupRuns.eventId,
  }).from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}

/**
 * Ütemezés az adatbázis állapotából: napi mentés, ha az utolsó sikeres 24 óránál régebbi; esemény-pillanatkép
 * minden lezárt eseményről, amelyhez még nincs sikeres. Hibás kísérlet után legfeljebb 30 percenként próbál újra.
 */
export async function runScheduledBackups(db: Db, cfg: Config, runner: BackupRunner, now = new Date()) {
  const recentTry = async (kind: string, eventId?: string) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(backupRuns).where(and(
      eq(backupRuns.kind, kind), eventId ? eq(backupRuns.eventId, eventId) : sql`true`,
      sql`${backupRuns.startedAt} > ${new Date(now.getTime() - 30 * 60_000)}`,
    ));
    return (r?.n ?? 0) > 0;
  };
  const [lastDaily] = await db.select().from(backupRuns).where(and(eq(backupRuns.kind, "daily"), eq(backupRuns.status, "ok"))).orderBy(desc(backupRuns.finishedAt)).limit(1);
  if ((!lastDaily?.finishedAt || now.getTime() - lastDaily.finishedAt.getTime() > 24 * 3600_000) && !(await recentTry("daily"))) {
    await runBackup(db, cfg, runner, "daily");
  }
  const closed = await db.select({ id: events.id }).from(events).where(eq(events.status, "closed"));
  for (const e of closed) {
    const [ok] = await db.select({ id: backupRuns.id }).from(backupRuns).where(and(eq(backupRuns.kind, "event_snapshot"), eq(backupRuns.eventId, e.id), eq(backupRuns.status, "ok"))).limit(1);
    if (!ok && !(await recentTry("event_snapshot", e.id))) await runBackup(db, cfg, runner, "event_snapshot", { eventId: e.id });
  }
  await pruneBackups(db, cfg, now);
}

/** Lejárt mentések törlése: napi 7 nap (legalább), snapshot hosszabb ideig. Mindig megmarad az utolsó sikeres. */
export async function pruneBackups(db: Db, cfg: Config, now = new Date()) {
  for (const [kind, days] of [["daily", cfg.BACKUP_DAILY_RETENTION_DAYS], ["manual", cfg.BACKUP_DAILY_RETENTION_DAYS], ["event_snapshot", cfg.BACKUP_SNAPSHOT_RETENTION_DAYS]] as const) {
    const cutoff = new Date(now.getTime() - days * 86400_000);
    const [newest] = await db.select({ id: backupRuns.id }).from(backupRuns).where(and(eq(backupRuns.kind, kind), eq(backupRuns.status, "ok"))).orderBy(desc(backupRuns.finishedAt)).limit(1);
    const old = await db.select().from(backupRuns).where(and(eq(backupRuns.kind, kind), eq(backupRuns.status, "ok"), lt(backupRuns.startedAt, cutoff)));
    for (const r of old) {
      if (r.id === newest?.id) continue;
      for (const f of [r.dbFile, r.photosFile]) if (f) await rm(f, { force: true });
      await db.delete(backupRuns).where(eq(backupRuns.id, r.id));
    }
  }
  void readdir;
}
