import { expect, test, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { BASE, approvalCredentials, bootstrapAdmin, dbQuery, localInput } from "../helpers";

const PASSWORD = "Correct-horse-42";
const STATION1 = { lat: 47.5, lon: 19.0 };
const STATION2 = { lat: 47.51, lon: 19.01 };
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function csrf(page: Page) { return page.evaluate(() => localStorage.getItem("th_csrf") ?? ""); }

test("teljes folyamat: admin → jelentkezés → jóváhagyás → check-in (online és offline) → fotó → szinkron", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const link = bootstrapAdmin("admin@example.hu");

  // ---------- Admin: aktiválás, belépés ----------
  const adminCtx = await browser.newContext({ baseURL });
  const admin = await adminCtx.newPage();
  await admin.goto(link);
  await admin.getByRole("button", { name: "Kezdés" }).click();
  const secret = (await admin.locator("code").first().innerText()).trim();
  await admin.locator('input[type="password"]').nth(0).fill(PASSWORD);
  await admin.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await admin.getByLabel(/6 számjegyű kód/).fill(authenticator.generate(secret));
  await admin.getByRole("button", { name: "Aktiválás" }).click();
  await expect(admin.getByText("A fiók aktív")).toBeVisible();
  await admin.getByRole("link", { name: "Tovább a belépéshez" }).click();
  await admin.getByLabel("E-mail cím").fill("admin@example.hu");
  await admin.locator('input[type="password"]').fill(PASSWORD);
  await admin.getByLabel(/Hitelesítő alkalmazás kódja/).fill(authenticator.generate(secret));
  await admin.getByRole("button", { name: "Belépés" }).click();
  await expect(admin.getByText("Kincsvadászat admin")).toBeVisible();

  // ---------- Admin: esemény létrehozása és megnyitása ----------
  await admin.getByRole("link", { name: "Események" }).click();
  await admin.getByRole("button", { name: "+ Új esemény" }).click();
  // Karakterenkénti gépelés: a modal nem lophatja el a fókuszt (korábbi hiba: az első betű után átugrott)
  const nameInput = admin.getByLabel("Név", { exact: true });
  await nameInput.click();
  await nameInput.pressSequentially("E2E Halloween");
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue("E2E Halloween");
  await admin.getByLabel("Jelentkezés kezdete").fill(localInput(-3600_000));
  await admin.getByLabel("Jelentkezés lezárása").fill(localInput(20 * 60_000));
  await admin.getByLabel(/Módosítási/).fill(localInput(30 * 60_000));
  await admin.getByLabel("Tervezett kezdés").fill(localInput(3600_000));
  await admin.getByLabel("Tervezett vége").fill(localInput(5 * 3600_000));
  await admin.getByRole("button", { name: "Mentés" }).click();
  await expect(admin.getByRole("heading", { name: "E2E Halloween" })).toBeVisible();
  await admin.getByRole("button", { name: "Jelentkezés megnyitása" }).click();
  await admin.getByRole("button", { name: "Megerősítem" }).click();
  await expect(admin.locator(".badge", { hasText: "Jelentkezés nyitva" }).first()).toBeVisible();

  // ---------- Nyilvános: csapat- és host-jelentkezés ----------
  const pub = await (await browser.newContext({ baseURL })).newPage();
  await pub.goto("/");
  await pub.getByRole("link", { name: "Részletek és jelentkezés" }).click();
  await expect(pub.getByRole("heading", { name: "E2E Halloween" })).toBeVisible();
  await expect(pub.locator("body")).not.toContainText("Állomás #");
  const eventUrl = pub.url();

  await pub.getByRole("link", { name: "Csapat jelentkezés" }).click();
  await pub.getByLabel("Csapatnév").fill("Dínók");
  await pub.getByLabel("Kapcsolattartó neve").fill("Kovács Anna");
  await pub.getByLabel("E-mail cím").fill("anna@example.hu");
  await pub.getByLabel("Telefonszám").fill("0630 123 4567");
  await pub.getByLabel("Tag 1 neve").fill("Panni");
  await pub.getByLabel(/Elfogadom az adatkezelési/).check();
  await pub.getByRole("button", { name: "Jelentkezés elküldése" }).click();
  await expect(pub.getByText("Köszönjük a jelentkezést!")).toBeVisible();

  await pub.goto(eventUrl + "/host");
  await pub.getByLabel("Kapcsolattartó neve").fill("Nagy Béla");
  await pub.getByLabel("E-mail cím").fill("bela@example.hu");
  await pub.getByLabel("Telefonszám").fill("+36 20 111 2233");
  await pub.getByLabel("Az állomás címe").fill("Fő utca 12., Teszthely");
  await pub.getByLabel(/Elfogadom/).check();
  await pub.getByRole("button", { name: "Jelentkezés elküldése" }).click();
  await expect(pub.getByText("Köszönjük a jelentkezést!")).toBeVisible();

  // ---------- Admin: pozíció megerősítése (API) és jóváhagyás (UI) ----------
  await admin.getByRole("link", { name: "Csapatok és hostok" }).click();
  await admin.getByRole("button", { name: /Hostok/ }).click();
  const hostId = (await dbQuery<{ id: string }>("select id from hosts limit 1"))[0]!.id;
  const put = await admin.request.put(`${BASE}/api/admin/hosts/${hostId}/location`, { data: { lat: STATION1.lat, lon: STATION1.lon }, headers: { "x-csrf-token": await csrf(admin) } });
  expect(put.ok()).toBeTruthy();
  await admin.reload();
  await admin.getByRole("button", { name: /Hostok/ }).click();
  await admin.getByRole("button", { name: "Jóváhagy" }).click();
  await expect(admin.locator(".badge", { hasText: "Jóváhagyva" }).first()).toBeVisible();
  await admin.getByRole("button", { name: /Csapatok \(/ }).click();
  await admin.getByRole("button", { name: "Jóváhagy" }).click();
  await expect(admin.locator(".badge", { hasText: "Jóváhagyva" }).first()).toBeVisible();

  // ---------- Esemény indítása ----------
  await admin.getByRole("link", { name: "Események" }).click();
  await admin.getByRole("button", { name: /Jelentkezés lezárása/ }).click();
  await admin.getByRole("button", { name: "Megerősítem" }).click();
  await expect(admin.locator(".badge", { hasText: "Előkészítés" }).first()).toBeVisible();
  await admin.getByRole("button", { name: "Esemény indítása" }).click();
  await admin.getByRole("button", { name: "Megerősítem" }).click();
  await expect(admin.locator(".badge", { hasText: "Folyamatban" }).first()).toBeVisible();
  // második (virtuális) állomás
  const evId = (await dbQuery<{ id: string }>("select id from events limit 1"))[0]!.id;
  const vs = await admin.request.post(`${BASE}/api/admin/events/${evId}/stations`, { data: { address: "Tér 3.", lat: STATION2.lat, lon: STATION2.lon, pickupMode: "gift_outside", confirmed: true }, headers: { "x-csrf-token": await csrf(admin) } });
  expect(vs.status()).toBe(201);

  // ---------- Csapat: belépés a levélben kapott linkkel ----------
  const { link: teamLink, pin } = await approvalCredentials("anna@example.hu");
  const teamCtx = await browser.newContext({ baseURL, geolocation: { latitude: STATION1.lat + 0.0003, longitude: STATION1.lon }, permissions: ["geolocation"] });
  const team = await teamCtx.newPage();
  await team.goto(teamLink);
  await team.getByLabel(/PIN/).fill(pin);
  await team.getByRole("button", { name: "Belépés" }).click();
  await expect(team.getByText("Összes")).toBeVisible();
  await expect(team.getByText("0/2")).toBeVisible();
  await expect(team.locator("body")).not.toContainText("Nagy Béla"); // a host neve sosem látszik

  // online check-in az 1. állomáson
  await team.getByRole("button", { name: /Állomás #1/ }).click();
  await team.getByRole("button", { name: /Megérkeztünk/ }).click();
  await expect(team.getByText("Teljesítve").first()).toBeVisible();
  // fotó feltöltés
  await team.locator('input[type="file"]').setInputFiles({ name: "kep.png", mimeType: "image/png", buffer: PNG });
  await expect(team.getByAltText("Fotó az állomásról")).toBeVisible();
  await team.getByRole("button", { name: "Bezárás" }).click();
  await expect(team.getByText("1/2")).toBeVisible();

  // ---------- Offline check-in a 2. állomáson, majd szinkron ----------
  await teamCtx.setGeolocation({ latitude: STATION2.lat, longitude: STATION2.lon });
  await teamCtx.setOffline(true);
  await team.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(team.getByText("Nincs internetkapcsolat")).toBeVisible();
  await team.getByRole("button", { name: /Állomás #2/ }).click();
  await team.getByRole("button", { name: /Megérkeztünk/ }).click();
  await expect(team.getByText(/1 teljesítés és 0 fotó vár szinkronizálásra/)).toBeVisible();
  await expect(team.getByText("Szinkronizálásra vár").first()).toBeVisible();
  // a szerver még nem tud róla
  expect((await dbQuery("select 1 from check_ins")).length).toBe(1);

  await teamCtx.setOffline(false);
  await team.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(team.getByText(/vár szinkronizálásra/)).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await dbQuery("select 1 from check_ins where source = 'offline' and status = 'accepted'")).length).toBe(1);
  await team.getByRole("button", { name: "Bezárás" }).click().catch(() => undefined);
  await expect(team.getByText("2/2")).toBeVisible({ timeout: 15_000 });

  // ---------- Host: belépés, látogatók, fotó jelentése → admin visszaállítja ----------
  const hostCreds = await approvalCredentials("bela@example.hu");
  const host = await (await browser.newContext({ baseURL })).newPage();
  await host.goto(hostCreds.link);
  await host.getByLabel(/PIN/).fill(hostCreds.pin);
  await host.getByRole("button", { name: "Belépés" }).click();
  await expect(host.getByRole("heading", { name: "Állomás #1" })).toBeVisible();
  await expect(host.getByText("Dínók")).toBeVisible(); // a látogató csapat neve
  await expect(host.locator("body")).not.toContainText("Panni"); // egyéni tagnév nem látszik
  await host.getByRole("button", { name: "Fotó megnyitása" }).click();
  await host.getByRole("button", { name: "Fotó jelentése" }).click();
  await host.getByRole("button", { name: "Jelentés küldése" }).click();
  await expect.poll(async () => (await dbQuery<{ status: string }>("select status from photos"))[0]?.status).toBe("hidden_reported");
  await admin.getByRole("link", { name: "Fotók" }).click();
  await admin.getByRole("button", { name: "Jelentett" }).click();
  await admin.getByRole("button", { name: /Fotó, 1\. állomás/ }).click();
  await expect(admin.getByText("Jelentés: Gyermek / adatvédelmi probléma")).toBeVisible();
  await admin.getByRole("button", { name: "Visszaállítás" }).click();
  await expect.poll(async () => (await dbQuery<{ status: string }>("select status from photos"))[0]?.status).toBe("visible");

  // ---------- Admin: irányítópult számai ----------
  await admin.getByRole("link", { name: "Irányítópult" }).click();
  await expect(admin.locator(".stat", { hasText: "teljesített check-in" }).locator("b")).toHaveText("2");
  await expect(admin.locator(".stat", { hasText: "fotó" }).first().locator("b")).toHaveText("1");
  await admin.getByRole("link", { name: "Audit napló" }).click();
  await expect(admin.getByText("event.active").first()).toBeVisible();
});
