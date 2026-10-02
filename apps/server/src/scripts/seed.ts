// Fejlesztői / demó adatok. ÉLES környezetben nem fut (nincs valódi jelszó/PIN a repositoryban).
// Használat: npm run seed -w @th/server
import { eq } from "drizzle-orm";
import { authenticator } from "otplib";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  checkIns, emailDeliveries, events, giftCycles, giftReports, hosts, photos, stations, teamMembers, teams,
} from "../db/schema.js";
import { audit } from "../services/audit.js";
import { beginActivation, completeActivation, inviteAdmin } from "../services/adminAuth.js";
import { createCredential } from "../services/accessAuth.js";
import { enqueueEmail } from "../services/outbox.js";

const cfg = loadConfig();
if (cfg.NODE_ENV === "production") {
  console.error("A seed élesben nem futtatható.");
  process.exit(1);
}
await runMigrations(cfg.DATABASE_URL);
const { db, pool } = createDb(cfg.DATABASE_URL);

const hour = 3600_000;
const now = Date.now();
const DEMO_ADMIN = { email: "demo-admin@example.hu", password: "Demo-jelszo-2026" };

// ---- Admin (demó jelszó + TOTP; csak fejlesztéshez) ----
const inv = await inviteAdmin(db, null, DEMO_ADMIN.email, "Demó Admin");
const act = await beginActivation(db, cfg, inv.token);
await completeActivation(db, cfg, inv.token, DEMO_ADMIN.password, authenticator.generate(act.secret));

// ---- Esemény (folyamatban) ----
const [ev] = await db.insert(events).values({
  name: "Demó Halloween", type: "halloween", status: "active", shortDescription: "Demó esemény fejlesztéshez.", organizerContact: "demo@example.hu",
  registrationStart: new Date(now - 72 * hour), registrationClose: new Date(now - 48 * hour), modificationDeadline: new Date(now - 36 * hour),
  plannedStart: new Date(now - hour), plannedEnd: new Date(now + 3 * hour), actualStart: new Date(now - hour), nextStationNumber: 1,
}).returning();

// ---- Hostok + állomások (Budapest környéki példakoordináták) ----
const base = { lat: 47.4979, lon: 19.0402 };
const hostRows: Array<typeof hosts.$inferSelect> = [];
const stationRows: Array<typeof stations.$inferSelect> = [];
for (let i = 1; i <= 4; i++) {
  const [h] = await db.insert(hosts).values({
    eventId: ev!.id, contactName: `Demó Host ${i}`, email: `host${i}@example.hu`, phone: "+36201112233", address: `Demó utca ${i}.`, normalizedAddress: `demo u ${i}`,
    latitude: base.lat + i * 0.002, longitude: base.lon, locationConfirmed: true, pickupMode: i % 2 ? "gift_outside" : "ring_bell", status: "approved", approvedAt: new Date(now - 80 * hour),
  }).returning();
  const [s] = await db.insert(stations).values({
    eventId: ev!.id, number: i, hostId: h!.id, address: h!.address, latitude: h!.latitude!, longitude: h!.longitude!, pickupMode: h!.pickupMode, participantNote: i === 2 ? "Csengess kétszer!" : null,
  }).returning();
  hostRows.push(h!); stationRows.push(s!);
}
// virtuális állomás
const [vs] = await db.insert(stations).values({ eventId: ev!.id, number: 5, hostId: null, address: "Demó tér (virtuális)", latitude: base.lat + 0.012, longitude: base.lon, pickupMode: "gift_outside" }).returning();
stationRows.push(vs!);
await db.update(events).set({ nextStationNumber: 6 }).where(eq(events.id, ev!.id));

// ---- Csapatok ----
const credentials: Array<{ team: string; link: string; pin: string }> = [];
const teamRows: Array<typeof teams.$inferSelect> = [];
for (let i = 1; i <= 4; i++) {
  const t = await db.transaction(async (tx) => {
    const [t] = await tx.insert(teams).values({
      eventId: ev!.id, name: `Demó csapat ${i}`, contactName: `Kapcsolattartó ${i}`, email: `team${i}@example.hu`, phone: "+36301234567", status: i === 4 ? "pending" : "approved", approvedAt: i === 4 ? null : new Date(now - 80 * hour),
    }).returning();
    await tx.insert(teamMembers).values([{ teamId: t!.id, name: "Gyerek", category: "child" }, { teamId: t!.id, name: "Felnőtt", category: "adult" }, ...(i % 2 ? [{ teamId: t!.id, name: "Gyerek 2", category: "child" as const }] : [])]);
    return t!;
  });
  teamRows.push(t);
  if (i < 4) {
    const { token } = await createCredential(db, "team", t.id, ev!.id, "482915");
    credentials.push({ team: t.name, link: `${cfg.PUBLIC_BASE_URL}/belepes/${token}`, pin: "482915" });
  }
}
for (const h of hostRows.slice(0, 2)) {
  const { token } = await createCredential(db, "host", h.id, ev!.id, "573016");
  credentials.push({ team: `Host (${h.address})`, link: `${cfg.PUBLIC_BASE_URL}/belepes/${token}`, pin: "573016" });
}

// ---- Check-inek (különböző haladás) ----
const at = (m: number) => new Date(now - m * 60_000);
const ci = async (t: number, s: number, minutesAgo: number) => db.insert(checkIns).values({
  eventId: ev!.id, teamId: teamRows[t]!.id, stationId: stationRows[s]!.id, status: "accepted", source: "online", originalAt: at(minutesAgo), receivedAt: at(minutesAgo), distanceM: 20, accuracyM: 8,
});
for (const s of [0, 1, 2, 3, 4]) await ci(0, s, 50 - s * 8); // az 1. csapat kész
for (const s of [0, 1]) await ci(1, s, 40 - s * 10);
await ci(2, 0, 20);

// ---- Fotók ----
await mkdir(path.resolve(cfg.PHOTO_DIR, ev!.id), { recursive: true });
for (const [ti, si, color] of [[0, 0, "#c2410c"], [0, 1, "#6d28d9"], [1, 0, "#15803d"]] as const) {
  const id = randomUUID();
  const full = await sharp({ create: { width: 1200, height: 800, channels: 3, background: color } }).jpeg().toBuffer();
  const thumb = await sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).jpeg().toBuffer();
  await writeFile(path.resolve(cfg.PHOTO_DIR, ev!.id, `${id}.jpg`), full);
  await writeFile(path.resolve(cfg.PHOTO_DIR, ev!.id, `${id}_t.jpg`), thumb);
  await db.insert(photos).values({ id, eventId: ev!.id, teamId: teamRows[ti]!.id, stationId: stationRows[si]!.id, fileKey: `${ev!.id}/${id}.jpg`, thumbKey: `${ev!.id}/${id}_t.jpg`, width: 1200, height: 800, bytes: full.length, originalAt: at(30) });
}

// ---- Ajándék: az 1. állomáson 3 jelzés (valószínűleg elfogyott), a 3.-on elfogyott ----
const [c1] = await db.insert(giftCycles).values({ stationId: stationRows[0]!.id, seq: 1 }).returning();
for (const t of teamRows.slice(0, 3)) await db.insert(giftReports).values({ cycleId: c1!.id, teamId: t.id });
await db.insert(giftCycles).values({ stationId: stationRows[2]!.id, seq: 1, status: "depleted", note: "Holnap újra lesz.", depletedAt: at(15) });

// ---- Értesítés + audit ----
await enqueueEmail(db, cfg, { type: "event_started", recipient: "team1@example.hu", data: { eventName: ev!.name }, dedupKey: "seed:event_started:1", eventId: ev!.id });
await audit(db, { actorType: "system", action: "seed.demo_data", entityType: "event", entityId: ev!.id, eventId: ev!.id });
void emailDeliveries;

console.log("\nDemó adatok létrehozva.\n");
console.log(`Admin: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}  (TOTP kulcs: ${act.secret})`);
console.log("\nCsapat / host belépések:");
for (const c of credentials) console.log(`- ${c.team}: ${c.link}  PIN: ${c.pin}`);
await pool.end();
