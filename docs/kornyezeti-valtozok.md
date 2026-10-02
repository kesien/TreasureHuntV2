# Környezeti változók

A konfiguráció környezeti változókból jön (`apps/server/src/config.ts`, zod-dal ellenőrizve; hiányzó kötelező érték esetén a szerver nem indul). A produkciós konfiguráció **nincs a repositoryban**: a `.env` fájl (vagy a titokkezelő) az üzemeltetőnél van. A `.env.example` csak példa.

| Változó | Kötelező | Alapérték | Leírás |
|---|---|---|---|
| `NODE_ENV` | igen éles környezetben | `development` | `production`: Secure süti, szigorú CSP (`upgrade-insecure-requests`), a példa-titok elutasítása. **Éles környezetben mindig `production`.** |
| `PORT` | nem | `3000` | A szerver portja a konténerben. |
| `PUBLIC_BASE_URL` | igen | `http://localhost:3000` | A nyilvános HTTPS cím (pl. `https://kincs.pelda.hu`); az e-mailekben lévő linkek ebből készülnek. |
| `DATABASE_URL` | igen | – | PostgreSQL kapcsolat, pl. `postgres://th:JELSZO@db:5432/th`. Compose-ban a `DB_PASSWORD`-ből áll össze. |
| `DB_PASSWORD` | compose | `th` | Az adatbázis jelszava a `docker-compose.yml`-ben. **Éles környezetben állítsd át.** |
| `APP_SECRET` | igen | – | Legalább 32 karakter véletlen érték. Ebből származik a titkosítási kulcs (SMTP jelszó, TOTP titkok, e-mail törzsek). **Elvesztése esetén ezek az adatok nem olvashatók; változtatása után az SMTP jelszót és a 2FA-t újra be kell állítani.** Generálás: `openssl rand -base64 48`. |
| `PHOTO_DIR` | nem | `./data/photos` (konténerben `/data/photos`) | Fotók könyvtára; perzisztens volume. |
| `BACKUP_DIR` | nem | `./data/backups` (konténerben `/data/backups`) | Mentések célkönyvtára; bármilyen mountolt tárhely (NAS, külső lemez, szinkronizált mappa). |
| `BACKUP_DAILY_RETENTION_DAYS` | nem | `7` | Napi/kézi mentések megőrzése napokban (legalább 7). |
| `BACKUP_SNAPSHOT_RETENTION_DAYS` | nem | `730` | Esemény-pillanatképek megőrzése napokban (legalább 30). |
| `GOOGLE_MAPS_API_KEY` | térképhez | – | Maps JavaScript API böngészőkulcs (publikus: a `/api/public/config` adja a kliensnek). **Kötelezően korlátozd HTTP referrer szerint** a saját domainedre, és csak a szükséges API-kat engedélyezd (Maps JavaScript, Directions). Kulcs nélkül a térkép nem jelenik meg (a csapatnézet listára vált). |
| `GOOGLE_MAPS_MAP_ID` | nem | `DEMO_MAP_ID` | A haladó markerekhez (AdvancedMarkerElement) kötelező map ID; éles használatra hozz létre sajátot a Cloud Console-ban. |
| `GOOGLE_GEOCODING_API_KEY` | nem | – | Geocoding API szerverkulcs, **IP-cím szerint korlátozva**. Üresen a Nominatim (OSM) a geokódoló. |
| `GOOGLE_GEOCODING_MONTHLY_LIMIT` | nem | `1000` | Havi plafon a Google geokódolási hívásokra (UTC naptári hónap). Elérése után automatikusan a Nominatim tartalék működik; a Rendszerállapot oldal 80%-nál figyelmeztet. Állítsd az ingyenes keret alá, és a Cloud Console-ban állíts be költségkeretet és riasztást is. |
| `WEB_DIST` | nem | `../web/dist` | A lefordított kliens helye a szerver munkakönyvtárához képest. |
| `APP_VERSION` | nem | `0.1.0` | A rendszerállapot oldalon megjelenő verzió. |
| `LOG_LEVEL` | nem | `info` | `trace` … `fatal`. |
| `WORKER_IN_PROCESS` | nem | `true` | `false`: a háttérmunkát külön folyamatban kell futtatni. |

## Admin által a felületen állítható (adatbázisban, titkosítva)

- **SMTP**: szerver, port, TLS/SSL, felhasználó, jelszó/API kulcs, feladó neve és címe (Beállítások menü). A jelszó sosem jelenik meg újra.

## Szándékosan nem konfigurálható

Az esemény vizuális témája (az esemény típusából adódik), a rate limitek értékei és a megőrzési idők (12/24 hónap) kódban rögzítettek; módosításuk kódváltoztatást és jogi egyeztetést igényel.
