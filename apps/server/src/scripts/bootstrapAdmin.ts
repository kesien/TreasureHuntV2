// Első admin létrehozása (nincs master admin; ezt egyszer a szerver üzemeltetője futtatja).
// Használat: npm run admin:bootstrap -- admin@example.hu "Név"
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { admins } from "../db/schema.js";
import { inviteAdmin } from "../services/adminAuth.js";

const [email, ...nameParts] = process.argv.slice(2);
if (!email) {
  console.error('Használat: npm run admin:bootstrap -- <email> "<név>"');
  process.exit(1);
}
const cfg = loadConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);
const existing = await db.select({ id: admins.id }).from(admins).limit(1);
if (existing.length > 0) {
  console.error("Már létezik admin; újabbat meglévő admin hívhat meg a felületen.");
  await pool.end();
  process.exit(1);
}
const { token } = await inviteAdmin(db, null, email, nameParts.join(" ") || email);
console.log(`Aktivációs link (72 óráig érvényes, egyszer használható):\n${cfg.PUBLIC_BASE_URL}/admin/activate?token=${token}`);
await pool.end();
