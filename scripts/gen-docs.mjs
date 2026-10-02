// Az API- és adatbázis-dokumentáció generálása a forráskódból (hogy ne avuljon el).
// Használat: node scripts/gen-docs.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const routesDir = path.join(root, "apps/server/src/routes");

// ---------- API ----------
const rows = [];
for (const f of readdirSync(routesDir).sort()) {
  const src = readFileSync(path.join(routesDir, f), "utf8");
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`"]([^`"]+)[`"]/g)) rows.push({ method: m[1].toUpperCase(), url: m[2], file: f });
  // ciklusban generált útvonalak (teams/hosts): `/api/admin/${type}s/:id/...` vagy `${base}/...`
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(`(?:\/api\/admin\/\$\{type\}s\/:id|\$\{base\})([^`]*)`/g)) {
    for (const t of ["teams", "hosts"]) rows.push({ method: m[1].toUpperCase(), url: `/api/admin/${t}/:id${m[2]}`, file: f });
  }
}
const auth = (u) =>
  u.startsWith("/api/admin/login") || u.includes("/activation/") || u.includes("/password-reset/") ? "nyilvános (rate limit)"
  : u.startsWith("/api/admin") ? "admin"
  : u.startsWith("/api/access/login") ? "nyilvános (rate limit)"
  : u.startsWith("/api/access") ? "csapat/host"
  : u.startsWith("/api/photos") ? "admin / jogosult résztvevő"
  : u === "/api/geocode" ? "admin vagy résztvevő"
  : "nyilvános";
const uniq = [...new Map(rows.filter((r) => !r.url.includes("${")).map((r) => [r.method + r.url, r])).values()]
  .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
let api = "# API dokumentáció\n\n> Automatikusan generált (`node scripts/gen-docs.mjs`) a `apps/server/src/routes` alapján. Ne szerkeszd kézzel.\n\n";
api += "## Általános szabályok\n\n";
api += "- Minden válasz JSON; a hibák alakja: `{ \"error\": \"kod\", \"message\": \"magyar, érthető üzenet\" }`. Stack trace és belső azonosító nem kerül a válaszba.\n";
api += "- A munkamenet HttpOnly, SameSite=Lax süti. Állapotváltoztató kérésekhez (POST/PUT/PATCH/DELETE) bejelentkezve kötelező az `X-CSRF-Token` fejléc (értéke a bejelentkezéskor / `/me` hívásnál kapott `csrfToken`).\n";
api += "- A jelentkezési végpontokhoz `Idempotency-Key` fejléc kell (8–100 karakter); azonos kulccsal ismételt kérés nem hoz létre új jelentkezést.\n";
api += "- Az idők ISO 8601 UTC formátumban utaznak; a megjelenítés Europe/Budapest.\n";
api += "- Valós idejű jelzés: SSE (`/api/admin/stream`, `/api/access/stream`), csak \"változott\" üzenet; az adatot a normál API adja.\n";
api += "- Rate limit: admin belépés, PIN belépés, PIN/jelszó helyreállítás, e-mail csere, geokódolás, check-in, szinkron, fotófeltöltés, fotójelentés.\n\n";
api += "## Végpontok\n\n| Metódus | Útvonal | Jogosultság | Forrás |\n|---|---|---|---|\n";
for (const r of uniq) api += `| ${r.method} | \`${r.url}\` | ${auth(r.url)} | ${r.file} |\n`;
writeFileSync(path.join(root, "docs/api.md"), api);

// ---------- Adatbázis ----------
const schema = readFileSync(path.join(root, "apps/server/src/db/schema.ts"), "utf8");
let db = "# Adatbázis séma\n\n> Automatikusan generált (`node scripts/gen-docs.mjs`) a `apps/server/src/db/schema.ts` alapján. A kézzel írt üzleti megkötések a lap alján vannak.\n\n";
db += "Időbélyegek UTC-ben (`timestamptz`). Migrációk: `apps/server/drizzle/` (Drizzle), induláskor automatikusan lefutnak.\n\n";
const parts = schema.split(/^export const (\w+) = pgTable\(/m).slice(1);
let count = 0;
for (let i = 0; i < parts.length; i += 2) {
  const body = parts[i + 1];
  const name = body.match(/^"(\w+)"/)[1];
  const end = body.search(/^\}/m);
  const cols = body.slice(0, end).split("\n");
  const rest = body.slice(end);
  count++;
  db += `## ${name}\n\n| Oszlop | Típus | Megjegyzés |\n|---|---|---|\n`;
  for (const line of cols) {
    const idm = line.match(/^\s*(\w+):\s*(id|createdAt)\(\)/);
    if (idm) { db += idm[2] === "id" ? "| id | uuid PK | |\n" : "| created_at | timestamptz | not null, default now |\n"; continue; }
    const ci = line.indexOf(" // ");
    const comment = ci >= 0 ? line.slice(ci + 4).trim() : "";
    const code = (ci >= 0 ? line.slice(0, ci) : line).replace(/,\s*$/, "");
    const m0 = code.match(/^\s*(\w+):\s*(\w+)\("(\w+)"[^)]*\)(.*)$/);
    if (!m0) continue;
    const c = [null, m0[1], m0[2], m0[3], m0[4], comment];
    const type = c[2] === "ts" ? "timestamptz" : c[2] === "doublePrecision" ? "double" : c[2];
    const mods = c[4].replace(/\.notNull\(\)/g, " not null").replace(/\.primaryKey\(\)/g, " PK").replace(/\.unique\(\)/g, " unique")
      .replace(/\.defaultNow\(\)/g, " default now").replace(/\.defaultRandom\(\)/g, " default random").replace(/\.default\(([^)]*)\)/g, " default $1")
      .replace(/\.references\(\(\) => (\w+)\.(\w+)[^)]*\)/g, " → $1.$2");
    db += `| ${c[3]} | ${type} | ${(mods.trim() + (c[5] ? " — " + c[5] : "")).trim()} |\n`;
  }
  const idx = [...rest.matchAll(/(uniqueIndex|index|check)\("(\w+)"\)/g)].map((x) => `\`${x[2]}\` (${x[1] === "uniqueIndex" ? "egyedi" : x[1] === "check" ? "check" : "index"})`);
  if (idx.length) db += `\nMegkötések / indexek: ${idx.join(", ")}\n`;
  db += "\n";
}
db += "## Üzleti megkötések, amelyeket az adatbázis kényszerít\n\n";
db += "- Egyszerre legfeljebb egy `active` esemény (`events_single_active_uq`, részleges egyedi index).\n";
db += "- Csapatnév egyedi eseményen belül, kis/nagybetűtől függetlenül (`teams_event_name_uq`).\n";
db += "- Cím egyedi eseményen belül a függő/jóváhagyott host jelentkezéseknél (`hosts_event_address_uq`).\n";
db += "- Csapatonként legalább egy gyermek tag: halasztott constraint trigger (`teams_child_ck`, `team_members_child_ck`).\n";
db += "- Egy csapat egy állomásra egyszer check-inelhet (`checkins_team_station_uq`); az offline queue-elem azonosítója is egyedi csapatonként.\n";
db += "- Állomásszám változatlan és nem használódik újra: számláló az eseményen (`events.next_station_number`) + egyedi (`stations_event_number_uq`).\n";
db += "- Egy csapat ajándék-ciklusonként egyszer jelezhet (`gift_reports_cycle_team_uq`); egy host egy állomást hozhat létre (`stations_host_uq`).\n";
db += "- Az `audit_logs` tábla csak hozzáfűzhető: UPDATE/DELETE trigger tiltja.\n";
db += "- Az e-mail deduplikációs kulcs egyedi (`email_deliveries.dedup_key`); admin e-mail-cím kis/nagybetűtől függetlenül egyedi.\n";
db += "- Jelentkezés idempotencia-kulcs egyedi eseményenként (`teams_idem_uq`, `hosts_idem_uq`).\n";
writeFileSync(path.join(root, "docs/adatbazis.md"), db);
console.log(`docs/api.md: ${uniq.length} végpont; docs/adatbazis.md: ${count} tábla`);
