// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getQueueState, enqueueCheckIn, enqueuePhoto, localProximity, reloadQueue, syncNow, discardItem } from "./queue";
import { StorageFullError, listItems, resetDbHandle } from "./db";

const pos = { latitude: 47.5, longitude: 19.0, accuracy: 12 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  await resetDbHandle(); // minden teszt tiszta adatbázissal indul
  await reloadQueue();
  vi.restoreAllMocks();
});

describe("helyi proximity", () => {
  it("belül / túl messze / pontatlan", () => {
    const st = { latitude: 47.5, longitude: 19.0 };
    expect(localProximity(pos, st, 120).result).toBe("ok");
    expect(localProximity({ ...pos, latitude: 47.51 }, st, 120).result).toBe("too_far");
    expect(localProximity({ ...pos, accuracy: 400 }, st, 120).result).toBe("inaccurate");
  });
});

describe("offline sor", () => {
  it("több független check-in sorba kerül; sikeres szinkron után törlődik", async () => {
    await enqueueCheckIn("st-1", pos);
    await enqueueCheckIn("st-2", pos);
    expect(getQueueState().items.length).toBe(2);
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { items: Array<{ clientId: string }> };
      return json({ results: body.items.map((i) => ({ clientId: i.clientId, status: "accepted" })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    await syncNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getQueueState().items.length).toBe(0);
    expect(getQueueState().lastSyncAt).not.toBeNull();
    await syncNow(); // üres sor: nincs újabb kérés → idempotens
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hálózati hiba: az elemek megmaradnak és érthető üzenet jelenik meg", async () => {
    await enqueueCheckIn("st-1", pos);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await syncNow();
    expect(getQueueState().items.length).toBe(1);
    expect(getQueueState().items[0]!.status).toBe("waiting");
    expect(getQueueState().lastError).toMatch(/Nem sikerült szinkronizálni/);
  });

  it("egy hibás elem nem blokkolja a többit; review és elutasítás külön kezelve", async () => {
    const a = await enqueueCheckIn("st-ok", pos);
    const b = await enqueueCheckIn("st-review", pos);
    const c = await enqueueCheckIn("st-bad", pos);
    vi.stubGlobal("fetch", vi.fn(async () => json({ results: [
      { clientId: a.id, status: "accepted" },
      { clientId: b.id, status: "needs_review", reason: "station_removed" },
      { clientId: c.id, status: "rejected", reason: "unknown_station" },
    ] })));
    await syncNow();
    const items = await listItems();
    expect(items.map((i) => i.id)).toEqual([c.id]);
    expect(items[0]).toMatchObject({ status: "error" });
    expect(getQueueState().notices).toEqual([expect.objectContaining({ stationId: "st-review", kind: "needs_review", reason: "station_removed" })]);
  });

  it("fotók: sikeres feltöltés törlődik, a hibás hibásnak jelölt és a többi mehet; kézi szinkron újrapróbálja a hibásat", async () => {
    await enqueuePhoto("st-1", new Blob(["a"], { type: "image/jpeg" }), "a.jpg");
    const bad = await enqueuePhoto("st-1", new Blob(["b"], { type: "image/jpeg" }), "b.jpg");
    await enqueuePhoto("st-1", new Blob(["c"], { type: "image/jpeg" }), "c.jpg");
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return n === 2 ? json({ error: "photo_limit", message: "x" }, 409) : json({ id: "p" }, 201);
    }));
    await syncNow();
    const left = await listItems();
    expect(left.length).toBe(1);
    expect(left[0]).toMatchObject({ id: bad.id, status: "error" });
    // kézi szinkron: a hibás elem újra próbálkozik
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: "p" }, 201)));
    await syncNow({ manual: true });
    expect((await listItems()).length).toBe(0);
  });

  it("fotó check-in nélkül még nem szinkronizált állomáson vár (nem vész el)", async () => {
    await enqueueCheckIn("st-1", pos);
    const p = await enqueuePhoto("st-1", new Blob(["a"]), "a.jpg");
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (u.includes("/sync/checkins")
      ? json({ results: [{ clientId: (await listItems())[0]!.id, status: "accepted" }] })
      : json({ error: "checkin_required", message: "x" }, 409))));
    await syncNow();
    const items = await listItems();
    expect(items.find((i) => i.id === p.id)).toMatchObject({ status: "waiting", attempts: 1 });
  });

  it("tárhelyhiba: egyértelmű hiba, a korábbi elemek megmaradnak", async () => {
    await enqueueCheckIn("st-1", pos);
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    await expect(enqueuePhoto("st-1", new Blob(["x"]), "x.jpg")).rejects.toBeInstanceOf(StorageFullError);
    spy.mockRestore();
    expect((await listItems()).length).toBe(1);
  });

  it("session lejárt (401): az elemek megmaradnak, a felhasználó kap útmutatást", async () => {
    await enqueueCheckIn("st-1", pos);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unauthorized", message: "Jelentkezz be." }, 401)));
    await syncNow();
    expect(getQueueState().items.length).toBe(1);
    expect(getQueueState().lastError).toMatch(/lépj be újra/);
  });

  it("kézi elvetés", async () => {
    const a = await enqueueCheckIn("st-1", pos);
    await discardItem(a.id);
    expect(getQueueState().items.length).toBe(0);
  });
});
