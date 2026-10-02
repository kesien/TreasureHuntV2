import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PICKUP_MODES } from "@th/shared";
import { requireAdmin, type RouteCtx } from "../app.js";
import { hit } from "../services/rateLimit.js";
import { AppError } from "../services/applications.js";
import { geocodeAddress, GeocodeError, withLocality } from "../services/geocode.js";
import { and, eq } from "drizzle-orm";
import { checkIns, events, hosts, teams } from "../db/schema.js";
import { giftSummary } from "../services/gifts.js";
import { confirmHostLocation, createVirtualStation, listStationsAdmin, removeStation, requiredStationCount, stationsForParticipant } from "../services/stations.js";

const uuid = z.string().uuid();
const coord = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), placeId: z.string().max(300).optional() });

export async function registerStationRoutes(app: FastifyInstance, { cfg, db, hub, geocoders }: RouteCtx) {
  /** Cím geokódolása az esemény településével szűkítve; a kliens a (placeId-val együtt) kapott pozíciót húzható markerrel megerősíti. */
  async function geocodeForEvent(evId: string | undefined, address: string) {
    const [ev] = evId ? await db.select().from(events).where(eq(events.id, evId)) : [];
    const center = ev?.centerLat != null && ev.centerLon != null ? { lat: ev.centerLat, lon: ev.centerLon } : null;
    const r = await geocodeAddress(db, geocoders, ev?.locality ? withLocality(address, ev.locality) : address);
    // Nem található: a kliens kézi markerhelyezést kínál (az esemény településének közepéről indulva)
    return r ? { found: true, lat: r.lat, lon: r.lon, label: r.label, placeId: r.placeId ?? null, center } : { found: false, center };
  }

  // Nyilvános (munkamenet nélküli) geokódolás a host-jelentkezéshez: csak nyitott jelentkezésű eseményre, IP-nként korlátozva
  app.post("/api/public/events/:id/geocode", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { address } = z.object({ address: z.string().min(5).max(300) }).parse(req.body);
    const [ev] = await db.select().from(events).where(eq(events.id, id));
    if (!ev || ev.status !== "registration_open") throw new AppError("registration_closed", "Ehhez az eseményhez most nem lehet jelentkezni.", 409);
    if (!(await hit(db, "geocode_public", req.ip, 20, 600))) throw new GeocodeError("rate_limited", "Túl sok címkeresés. Próbáld újra később.");
    return geocodeForEvent(id, address);
  });

  // Geokódolás csak a backendről (nem a böngészőből); bejelentkezett admin vagy résztvevő használhatja
  app.post("/api/geocode", async (req, reply) => {
    const who = req.admin?.id ?? req.access?.credentialId;
    if (!who) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const { address, eventId } = z.object({ address: z.string().min(5).max(300), eventId: uuid.optional() }).parse(req.body);
    if (!(await hit(db, "geocode_user", who, 20, 600))) throw new GeocodeError("rate_limited", "Túl sok címkeresés. Próbáld újra később.");
    // Résztvevőnél az esemény a munkamenetből adódik; adminnál a kliens küldi
    return geocodeForEvent(req.access?.eventId ?? eventId, address);
  });

  // ---------- Host ----------
  app.put("/api/access/host/location", async (req, reply) => {
    if (req.access?.subjectType !== "host") return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const b = coord.parse(req.body);
    const r = await confirmHostLocation(db, { type: "host", id: req.access.subjectId }, req.access.subjectId, b.lat, b.lon, b.placeId);
    hub.publish("admin", "stations");
    return { ok: true, ...r };
  });

  // ---------- Résztvevő (team/host) ----------
  app.get("/api/access/stations", async (req, reply) => {
    if (!req.access) return reply.code(401).send({ error: "unauthorized", message: "Jelentkezz be." });
    const [row] = req.access.subjectType === "team"
      ? await db.select({ status: teams.status }).from(teams).where(eq(teams.id, req.access.subjectId))
      : await db.select({ status: hosts.status }).from(hosts).where(eq(hosts.id, req.access.subjectId));
    if (row?.status !== "approved") throw new AppError("not_approved", "A hozzáférés nem aktív.", 403);
    const base = await stationsForParticipant(db, req.access.eventId);
    if (!base.revealed || req.access.subjectType !== "team") return base;
    // Csapatnézet: teljesített / elfogyott állapot (más csapatról semmi sem látszik)
    const mine = await db.select({ stationId: checkIns.stationId }).from(checkIns).where(and(eq(checkIns.teamId, req.access.subjectId), eq(checkIns.status, "accepted")));
    const done = new Set(mine.map((m) => m.stationId));
    const stationsOut = [];
    for (const s of base.stations) {
      const g = await giftSummary(db, s.id);
      stationsOut.push({ ...s, completed: done.has(s.id), giftStatus: g.status, giftNote: g.status === "depleted" ? g.note : null, likelyOut: g.likelyOut });
    }
    return { ...base, stations: stationsOut };
  });

  // ---------- Admin ----------
  app.put("/api/admin/hosts/:id/location", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = coord.parse(req.body);
    const r = await confirmHostLocation(db, { type: "admin", id: req.admin.id }, id, b.lat, b.lon, b.placeId);
    hub.publish("admin", "stations");
    return { ok: true, ...r };
  });

  app.get("/api/admin/events/:id/stations", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { required: await requiredStationCount(db, id), stations: await listStationsAdmin(db, id) };
  });

  app.post("/api/admin/events/:id/stations", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      address: z.string().min(3).max(300), lat: z.number(), lon: z.number(), pickupMode: z.enum(PICKUP_MODES),
      participantNote: z.string().max(500).optional(), confirmed: z.boolean(),
    }).parse(req.body);
    const r = await createVirtualStation(db, req.admin.id, id, b);
    hub.publish("admin", "stations");
    hub.publish(`event:${id}`, "stations");
    return reply.code(201).send(r);
  });

  app.delete("/api/admin/stations/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string() }).parse(req.body);
    await removeStation(db, cfg, req.admin.id, id, reason);
    hub.publish("admin", "stations");
    return { ok: true };
  });
}
