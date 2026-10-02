// Önálló háttérfolyamat (WORKER_IN_PROCESS=false esetén a webszerver mellett futtatandó):
//   node dist/workerMain.js
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./logger.js";
import { startWorker } from "./worker.js";

const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL);
const log = createLogger();
startWorker(db, cfg, { error: (o, m) => log.error(o, m) });
log.info("worker elindult");
