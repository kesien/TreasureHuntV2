import { eq } from "drizzle-orm";
import { events, hosts, stations, teamMembers, teams } from "../src/db/schema.js";
import { accessLogin, createCredential } from "../src/services/accessAuth.js";
import type { Ctx } from "./helpers.js";

export const hour = 3600_000;
export const LAT = 47.5, LON = 19.0;

export async function world(ctx: Ctx, nStations = 2, nTeams = 3) {
  const now = Date.now();
  const [ev] = await ctx.db.insert(events).values({
    name: "E", type: "halloween", status: "active", actualStart: new Date(now - hour), registrationStart: new Date(now - 100 * hour),
    registrationClose: new Date(now - 50 * hour), modificationDeadline: new Date(now - 40 * hour), plannedStart: new Date(now - hour), plannedEnd: new Date(now + 3 * hour),
  }).returning();
  const sts = [];
  const hostRows = [];
  for (let i = 1; i <= nStations; i++) {
    const [h] = await ctx.db.insert(hosts).values({
      eventId: ev!.id, contactName: "Host" + i, email: `h${i}@x.hu`, phone: "+36201112233", address: "A " + i, normalizedAddress: "a " + i,
      pickupMode: "ring_bell", status: "approved", latitude: LAT + i * 0.01, longitude: LON, locationConfirmed: true,
    }).returning();
    const [s] = await ctx.db.insert(stations).values({ eventId: ev!.id, number: i, hostId: h!.id, address: "A " + i, latitude: LAT + i * 0.01, longitude: LON, pickupMode: "ring_bell" }).returning();
    sts.push(s!); hostRows.push(h!);
  }
  await ctx.db.update(events).set({ nextStationNumber: nStations + 1 }).where(eq(events.id, ev!.id));
  const tms = [];
  for (let i = 1; i <= nTeams; i++) {
    const t = await ctx.db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values({ eventId: ev!.id, name: "Csapat" + i, contactName: "K", email: `t${i}@x.hu`, phone: "+36301234567", status: "approved", approvedAt: new Date(0) }).returning();
      await tx.insert(teamMembers).values([{ teamId: t!.id, name: "g", category: "child" }, { teamId: t!.id, name: "f", category: "adult" }]);
      return t!;
    });
    const { token } = await createCredential(ctx.db, "team", t.id, ev!.id, "481952");
    const l = await accessLogin(ctx.db, token, "481952", "9.9.9." + i);
    tms.push({ ...t, cookie: `th_access=${l.sessionToken}`, csrf: l.csrfToken });
  }
  return { ev: ev!, sts, tms, hostRows };
}
export async function hostSession(ctx: Ctx, h: { id: string }, evId: string) {
  const { token } = await createCredential(ctx.db, "host", h.id, evId, "481952");
  const l = await accessLogin(ctx.db, token, "481952", "8.8.8.8");
  return { cookie: `th_access=${l.sessionToken}`, "x-csrf-token": l.csrfToken };
}
export const hd = (t: { cookie: string; csrf: string }) => ({ cookie: t.cookie, "x-csrf-token": t.csrf });
export const ci = (ctx: Ctx, t: { cookie: string; csrf: string }, stationId: string, lat = LAT, lon = LON, accuracy: number | null = 10) =>
  ctx.app.inject({ method: "POST", url: "/api/access/checkin", headers: hd(t), payload: { stationId, latitude: lat, longitude: lon, accuracy } });

