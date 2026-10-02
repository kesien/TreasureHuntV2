import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { startWorker } from "./worker.js";

const cfg = loadConfig();
await runMigrations(cfg.DATABASE_URL);
const { db } = createDb(cfg.DATABASE_URL);
const app = await buildApp({ cfg, db });
// A worker alapból a webfolyamatban fut; külön folyamatban WORKER_IN_PROCESS=false és `node dist/workerMain.js`
if (process.env.WORKER_IN_PROCESS !== "false") startWorker(db, cfg, app.log);
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
