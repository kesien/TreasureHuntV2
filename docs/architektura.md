# Architektúra áttekintés

Self-hosted, mobil-first PWA egy kisvárosi, szezonális közösségi eseményhez (Halloween/Húsvét): csapatok járják az állomásokat, GPS-alapú „Megérkeztünk" check-int és fotót adnak, a házigazdák látják a hozzájuk érkezőket, az admin kezeli az egészet. Nem cél: verseny, ranglista, élő követés, útvonaltervezés.

## Komponensek

```
┌─────────────────────────┐     HTTPS      ┌──────────────────────────────────────────────┐
│ Telefon / böngésző (PWA)│ ─────────────▶ │ Reverse proxy (Caddy/nginx, opcionális)       │
│  React + Vite           │                └───────────────┬──────────────────────────────┘
│  Service worker         │                                ▼
│  IndexedDB offline sor  │   SSE / REST   ┌──────────────────────────────┐   ┌────────────┐
└─────────────────────────┘ ◀────────────▶ │ app: Fastify (API + statikus │──▶│ PostgreSQL │
                                            │ kliens) + beépített worker   │   └────────────┘
                                            └───────┬──────────────┬───────┘
                                                    ▼              ▼
                                            fotók (volume)    mentések (volume)
```

- **app**: egyetlen Node-folyamat szolgálja ki az API-t és a lefordított klienst. A háttérmunkák (e-mail, ütemezett feladatok, megőrzés, mentés) alapból ugyanebben futnak (`WORKER_IN_PROCESS=false` + külön folyamat is lehetséges).
- **PostgreSQL**: az egyetlen igazságforrás, a háttérmunkák is az adatbázis állapotából dolgoznak (nem cron-időzítésből), ezért újraindítás után sem duplikálnak.
- **Fájltárolás**: a fotók és a mentések volume-on, a fotók elérése jogosultság-ellenőrzéssel az API-n át történik (nincs publikus statikus fotókönyvtár).

## Technológiai döntések és indoklás

| Terület | Választás | Indok |
|---|---|---|
| Nyelv | TypeScript (Node 22) | Egy nyelv szerveren és kliensen; a megosztott szabályok (PIN, telefon, geo, életciklus) egy helyen vannak (`packages/shared`) |
| API | Fastify 5 + zod | Stabil, gyors, kiforrott pluginok (cookie, helmet, multipart, static); zod a bemenet-ellenőrzéshez |
| Adatbázis | PostgreSQL 16 + Drizzle ORM | Erős megkötések (részleges egyedi index, check, trigger); egyszerű, típusos migráció |
| Háttérmunka | saját, DB-állapotú worker | Nincs külön Redis/queue; az idempotencia dedup kulcsokkal és zárolással (`for update skip locked`) |
| Kliens | React 18 + Vite + react-router | Kiforrott, jó PWA-támogatás; lusta betöltés (admin és térkép külön csomag) |
| PWA | vite-plugin-pwa (Workbox) | Telepíthető, app shell offline; az API-t nem cache-eli a service worker |
| Offline | IndexedDB (`idb`) | Fotó Blob-ként is tárolható; localStorage erre nem alkalmas |
| Valós idő | SSE (+ újracsatlakozáskor teljes frissítés) | Egyirányú frissítés elég, proxy-barát, egyszerű; a jelzés csak „változott", így a jogosultságot mindig a normál API ellenőrzi |
| Térkép | Google Maps JavaScript API (`@googlemaps/js-api-loader`), AdvancedMarkerElement, InfoWindow | Pontos magyar címlefedettség (az OSM-ben sok kisvárosi házszám hiányzik); a kulcs referrer-korlátozott; offline nem működik, a csapatnézet listára esik vissza |
| Útvonal | Google DirectionsService (`optimizeWaypoints`, gyalog), kliensoldalon | Opcionális javaslat a hátralévő állomásokra; a pozíciót nem tároljuk és nem naplózzuk |
| Geokódolás | szerveroldali `GeocoderProvider` lánc: Google Geocoding API (havi plafonnal) → Nominatim tartalék | Cache + plafon + fallback; a böngésző sosem hív geokódolót; a geokódolás csak javaslat, a pozíciót a host/admin megerősíti a térképen |
| Képfeldolgozás | sharp + file-type + heic-decode | Tartalom-ellenőrzés, pixelkorlát, EXIF/GPS törlés, átméretezés; a sharp előre fordított változata HEIC-et nem tud, ezért a HEIC-et WASM dekóder oldja meg |
| E-mail | nodemailer (SMTP) | Szabványos, nincs szolgáltatófüggés |
| Auth | argon2id (PIN/jelszó), SHA-256 (nagy entrópiájú tokenek), otplib TOTP | A tokeneket csak hash-elve tároljuk |
| Teszt | Vitest, Playwright | Egység/integráció/E2E/offline |
| Telepítés | Docker Compose | `app` + `db`, perzisztens volume-ok |

Nem használtunk: Redis, Kubernetes, Grafana/Prometheus, push infrastruktúra (a spec szerint nem MVP). A térkép és a geokódolás Google Maps Platform (kulcs + havi plafon + költségkeret az üzemeltetőnél).

## Szerepkörök és hozzáférés

- **Csapat / host**: egyedi hozzáférési link (256 bites véletlen token, csak SHA-256 hash-e tárolt) + 6 számjegyű PIN (argon2id). Eszközönként külön munkamenet (HttpOnly, Secure, SameSite=Lax süti + CSRF token). Kijelentkezés csak az adott eszközt érinti. **PIN-csere / helyreállítás minden munkamenetet megszüntet**; **link-újragenerálás** csak a régi linket érvényteleníti. Hibás PIN-re zárolás és IP-alapú rate limit.
- **Admin**: e-mail + erős jelszó (min. 12 karakter, betű + szám) + kötelező TOTP 2FA; helyreállító kódok (egyszer használhatók, auditált); meghívásos regisztráció; archiválás (nincs törlés); munkamenet-időkorlát (8 óra inaktivitás). Nincs master admin; az első admint az üzemeltető parancssorból hozza létre.
- **Megtekintés csapatként/hostként**: csak olvasható, munkamenet nélküli lekérdezés, auditált; az admin munkamenete participant műveletre nem jogosít.

## Állapotgépek

**Esemény**: `draft → registration_open → preparation → active → closed`; `cancelled` bármelyik nem végállapotból (indok kötelező). Végállapot nem nyitható újra. Egyszerre egy `active` esemény (adatbázis-szintű részleges egyedi index).
- A jelentkezés a lezárási időpontban automatikusan `preparation`-be lép; az indítás és a befejezés szándékosan kézi (az actual idő a mérvadó).
- Indításkor a függő jelentkezések `expired` státuszba kerülnek (e-mail + audit).
- Lezárás + 7 nap után a résztvevői hozzáférések megszűnnek; lemondáskor azonnal.

**Csapat/host**: `pending → approved | rejected | expired`; `approved → withdrawn | removed`; `archived`. Host címváltozás: `approved → pending` (újra jóváhagyás), az állomás kikerül, jóváhagyáskor ugyanazt a számot kapja vissza.

**Állomás**: `active → removed` (indok kötelező, szám nem használódik újra).

**Ajándék-ciklus**: `has_gifts → depleted`; a „valószínűleg elfogyott" származtatott figyelmeztetés (≥3 különböző csapat jelzése az aktuális ciklusban); „Újra feltöltöttem" új ciklust nyit, a régi jelzések nem számítanak bele.

**Check-in**: `accepted | needs_review → accepted | rejected`.

**Fotó**: `visible | hidden_reported | pending_review | rejected | deleted`.

## T−24 szabály

A helyszínek a tervezett kezdés előtt 24 órával válnak láthatóvá; előtte csak az állomások száma látszik (nincs cím, koordináta, marker). Ha az admin korábban indítja az eseményt, a helyszínek az indítás pillanatában azonnal felfedődnek. A T−24 e-mail egyszer megy, csak a T−24 előtt jóváhagyottaknak. Aktív esemény közben hozzáadott állomás azonnal látható; eltávolított azonnal eltűnik.

## GPS check-in

A kliens elküldi a pozíciót és a pontosságot; **a szerver** számolja a távolságot (haversine), ellenőrzi a sugarat (alap: 120 m, eseményenként állítható), az esemény/csapat/állomás állapotát, és szerveroldali időbélyeget ad. A pontos koordináta **nem tárolódik és nem naplózódik**, csak a számolt távolság, a pontosság, az állapot és az idő. 100 m-nél pontatlanabb GPS-sel nem döntünk (újrapróbálás). Egy csapat egy állomásra egyszer jelentkezhet be (adatbázis-szintű egyediség + idempotens API).

**Játékidő**: a csapat első sikeres check-injétől számolódik, az elvárt állomások teljesítésekor befagy. A „kész" állapot menet közben számolódik: új állomás hozzáadásakor a csapat újra nyitott, eltávolításkor az elvárt szám csökken. Az esemény végén a részleges állapot befagy.

## Offline működés

```
[Megérkeztünk] ─ online? ─ igen ─▶ POST /api/access/checkin ─▶ szerver dönt
                    │
                    nem (hálózati hiba)
                    ▼
            helyi proximity-ellenőrzés ─▶ IndexedDB sor (clientId = idempotencia kulcs)
                    ▼                       UI: „Szinkronizálásra vár"
        online / app megnyitása / 30 mp / „Szinkronizálás most"
                    ▼
        POST /api/access/sync/checkins (≤50 elem) → elemenként: accepted | duplicate | needs_review | rejected
        fotók: POST …/photos (clientId + capturedAt), elemenként
```

- A szerver újraellenőriz mindent; a kliens sosem ír felül szerver állapotot. A koordináta csak a szinkron kérés idejéig él a szerveren.
- Az **eredeti helyi időbélyeg** és a **szerver fogadási ideje** külön tárolódik; a játékidő az eredetiből számolódik.
- Admin review-ra kerül (nem automatikusan elfogadott): törölt állomás, esemény vége utáni időbélyeg, esemény kezdete előtti időbélyeg, irreális (jövőbeli) telefonóra, távolság-eltérés, pontatlan GPS. A hozzá tartozó fotó `pending_review`; elfogadáskor láthatóvá válik, elutasításkor nem jelenik meg a galériában.
- Ismeretlen állomásra az offline kliens nem hozhat létre check-int. Új állomást csak szinkron után ismer meg.
- A queue elemei addig próbálkoznak, amíg sikerül vagy manuális beavatkozás kell; egy hibás elem nem blokkol másikat. Tárhelyhiba esetén egyértelmű hibaüzenet, a korábbi elemek megmaradnak.
- iOS-en nincs háttér-szinkron ígéret: az app megnyitásakor / online eseménykor / kézi gombra szinkronizál.

## Fotók

Feltöltés csak sikeres check-in után. Szerveroldal: tartalom-alapú típusellenőrzés (JPEG/PNG/WebP/HEIC/HEIF), max. 20 MB, pixelkorlát (64 MP) a dekompressziós bomba ellen, egyszerre legfeljebb 2 feldolgozás, EXIF-tájolás alkalmazása majd **teljes metaadat- és GPS-törlés**, max. 2560 px, JPEG újrakódolás + bélyegkép; az eredeti nagy fájl nem marad meg. Csapatonként és állomásonként legfeljebb 5 fotó (zárolt tranzakció). A galéria anonim (csapatnév csak az adminnak). Jelentett fotó azonnal rejtetté válik; az admin visszaállít vagy véglegesen töröl (nincs „figyelmen kívül hagyás"). A csapat a saját fotóját bármikor törölheti.

## E-mail és értesítések

Outbox-minta: a küldés a DB-tranzakciótól független; az adat sosem vész el e-mail hiba miatt. Deduplikációs kulcs (címzett + típus + entitás + esemény), 5 próba növekvő várakozással, állapot: Elküldve / Függőben–újrapróbálás / Sikertelen / Újraküldés; kézi újraküldés percenként legfeljebb egyszer címzett+típus szerint. 15 magyar HTML + szöveges sablon. A belépési linket/PIN-t tartalmazó levelek törzse sikeres küldés után törlődik az adatbázisból (új hozzáférés kiadásával pótolható).

## Mentés és megőrzés

Lásd: [mentes-visszaallitas.md](mentes-visszaallitas.md). Megőrzés (operátori policy, nem jogi állítás): személyes adat anonimizálása ~12 hónappal a lezárás után, fotók törlése 24 hónap után, az audit napló korlátlan, az aggregált statisztika megmarad.

## Idő és időzóna

Tárolás UTC-ben (`timestamptz`), megjelenítés magyar formátumban, 24 órás idővel, Europe/Budapest zónában; az ütemezett események az adatbázisban tárolt időpontokból számolódnak.

## Spec-ellentmondások és hiányok – hogyan kezeltük

1. **T−24 az actual startból** – az indításig nem ismert; ezért a tervezett kezdésből számolunk, korábbi indításnál azonnal felfed.
2. **„Lejárt – nem került jóváhagyásra"** nincs a státuszlistában – külön `expired` státusz.
3. **Új állomás aktív eseményben vs. completion freeze** – a csapat újra nyitott lesz; újrateljesítéskor a játékidő újra befagy.
4. **Offline szerveroldali GPS-újraellenőrzés** koordináta nélkül nem lehetséges – a szinkron kérés átmenetileg tartalmazza (nem tárolt, nem naplózott).
5. **Visszalépési határidő** nincs külön megadva – egyezik a módosítási határidővel.
6. **Késői team jóváhagyás** – az esemény indításáig lehetséges, azután a függő lejár (a host-szabály analógiája).
7. **Első admin** – parancssori bootstrap (`npm run admin:bootstrap`).
8. **HEIC** – WASM dekóder (`heic-decode`), valódi iPhone-os fájllal kézzel ellenőrizendő.
9. **Anonimizálás vs. korlátlan audit** – az audit csak azonosítókat és minimális adatot tartalmaz, az entitás személyes adata törlődik.
10. **Host pozíciójának megerősítése** – a host a jelentkezéskor maga erősíti meg a térképen (nyilvános, IP-nként korlátozott geokódoló végpont; a jelölő húzható); ha ez nem sikerül, pozíció nélkül is jelentkezhet, és ilyenkor az admin erősít meg a jóváhagyás előtt. Az admin mindig felülbírálhatja. A jóváhagyás csak megerősített pozícióval megy.
11. **Fotó-láthatóság „jogosult résztvevők"** – az állomáson becsekkolt csapatok, az állomás hostja és az admin.
12. **Pontatlan GPS határa** – a spec nem rögzítette; 100 m (`MAX_ACCURACY_M`).
