import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { smtpTransport, type MailTransport } from "./services/mailer.js";
import { processDue } from "./services/outbox.js";
import { purgeRateLimitHits } from "./services/rateLimit.js";
import { runScheduled } from "./services/scheduler.js";
import { DefaultBackupRunner, runScheduledBackups, type BackupRunner } from "./services/backup.js";
import { heartbeat } from "./services/adminOps.js";
import { runRetention } from "./services/retention.js";

/**
 * Háttérmunkák: e-mail outbox feldolgozás és takarítás. Minden munka idempotens és az adatbázis
 * állapotából dolgozik (nem cron-időzítésből), így újraindítás után sem duplikál.
 */
export function startWorker(db: Db, cfg: Config, log: { error: (o: object, m: string) => void }, transport: MailTransport = smtpTransport(db, cfg), backupRunner: BackupRunner = new DefaultBackupRunner()) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await heartbeat(db);
      await runScheduled(db, cfg);
      await processDue(db, cfg, transport);
    } catch (err) {
      log.error({ err }, "worker tick failed");
    } finally {
      running = false;
    }
  };
  const mail = setInterval(tick, 10_000);
  const hourly = async () => {
    try {
      await purgeRateLimitHits(db);
      await runRetention(db, cfg);
      await runScheduledBackups(db, cfg, backupRunner);
    } catch (err) {
      log.error({ err }, "hourly jobs failed");
    }
  };
  const cleanup = setInterval(hourly, 3600_000);
  setTimeout(hourly, 30_000); // indulás után röviddel is lefut (pl. kimaradt napi mentés pótlása)
  return () => { clearInterval(mail); clearInterval(cleanup); };
}
