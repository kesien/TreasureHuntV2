# Telepítési útmutató (Docker)

Ez az útmutató egy saját szerverre, Docker Compose-szal, HTTPS-sel és saját domainnel történő üzembe helyezést ír le. A kiszolgálón nincs szükség fizetős felhőszolgáltatásra.

## Követelmények

- Linux szerver (vagy bármely Docker-képes gép), Docker 24+ és Docker Compose v2.
- Saját domain (pl. `kincs.pelda.hu`), amely a szerverre mutat; 80/443-as port elérhető.
- Egy SMTP szolgáltatás (bármely szabványos: saját levelezőszerver, vagy ingyenes/olcsó szolgáltató).
- Kb. 2 GB RAM, a fotóknak és a mentéseknek elegendő tárhely (100–120 résztvevőnél néhány GB bőven elég).

## 1. Kód és konfiguráció

```bash
git clone <repository> kincsvadaszat && cd kincsvadaszat
cp .env.example .env
```

A `.env`-ben állítsd be (részletek: [kornyezeti-valtozok.md](kornyezeti-valtozok.md)):

```ini
NODE_ENV=production
PUBLIC_BASE_URL=https://kincs.pelda.hu
APP_SECRET=<openssl rand -base64 48 kimenete>
DB_PASSWORD=<erős, véletlen jelszó>
```

**Fontos:** az `APP_SECRET`-et és a `.env`-et őrizd biztonságos helyen (jelszókezelő); a repositoryba soha nem kerülhet. Az `APP_SECRET` elvesztése esetén az SMTP-jelszó és a 2FA titkok nem olvashatók.

## 2. Indítás

```bash
docker compose up -d --build
docker compose logs -f app      # induláskor automatikusan lefutnak az adatbázis-migrációk
```

A `docker-compose.yml` szolgáltatásai: `db` (PostgreSQL 16), `app` (API + kliens + háttérmunkák). Perzisztens volume-ok: `pgdata` (adatbázis), `photos` (fotók), `backups` (mentések).

## 3. HTTPS és reverse proxy

A `app` a 3000-es porton HTTP-t szolgál ki; a HTTPS-t reverse proxy végzi. Példa **Caddy**-vel (automatikus Let's Encrypt tanúsítvány) – `Caddyfile`:

```
kincs.pelda.hu {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1      # az SSE (élő frissítés) miatt ne pufferelje a választ
    }
    request_body {
        max_size 25MB          # a 20 MB-os fotók miatt
    }
}
```

nginx esetén: `proxy_set_header X-Forwarded-For $remote_addr; proxy_buffering off;` (SSE) és `client_max_body_size 25m;`. A szerver a `X-Forwarded-For` fejlécből veszi a kliens IP-jét (rate limithez), ezért **csak a reverse proxy-n keresztül legyen elérhető** (a 3000-es portot ne tedd ki közvetlenül az internetre; a `docker-compose.yml`-ben érdemes `127.0.0.1:3000:3000`-ra szűkíteni).

Ellenőrizd: a böngészőben `https://kincs.pelda.hu/api/health` → `{"ok":true}`, a süti `Secure` és `HttpOnly` (production módban automatikus).

## 4. Első admin

Nincs master admin; az első admint egyszer az üzemeltető hozza létre:

```bash
docker compose exec app npm run admin:bootstrap -- admin@pelda.hu "Teljes Név"
```

(Alternatíva: `docker compose exec app node dist/scripts/bootstrapAdmin.js admin@pelda.hu "Teljes Név"`.) A parancs csak akkor fut, ha még nincs admin.

A parancs kiírja a 72 óráig érvényes, egyszer használható aktivációs linket. Nyisd meg, állíts be erős jelszót és a hitelesítő alkalmazást (TOTP), és **mentsd el a helyreállító kódokat**. További adminokat az admin felületen meghívással lehet felvenni.

## 5. SMTP beállítása

Admin felület → Beállítások → e-mail (SMTP): szerver, port, TLS/SSL, felhasználó, jelszó, feladó neve és címe. Tesztelés: hívj meg egy második admint (a meghívó levél az Értesítések oldalon követhető), vagy küldj teszt-jelentkezést. Hibás SMTP esetén a levelek a sorban maradnak, és újrapróbálódnak; a hibaok az Értesítések oldalon látszik.

## 6. Térkép, geokódolás és útvonal (Google Maps Platform)

1. Hozz létre Google Cloud projektet, kapcsold be a számlázást, és **állíts be költségkeretet és riasztást** (Billing → Budgets & alerts).
2. Engedélyezd az API-kat: **Maps JavaScript API**, **Geocoding API**, **Directions API** (utóbbi legacy lehet új projekteknél; ha nem engedélyezhető, az útvonal-funkció nem működik, a többi igen).
3. Hozz létre **két API-kulcsot**:
   - *Böngészőkulcs* (`GOOGLE_MAPS_API_KEY`): Application restriction = HTTP referrers (`https://kincs.pelda.hu/*`), API restriction = Maps JavaScript API + Directions API. Ez publikus a kliensben, ezért a korlátozás kötelező.
   - *Szerverkulcs* (`GOOGLE_GEOCODING_API_KEY`): Application restriction = IP addresses (a szervered kimenő IP-je), API restriction = Geocoding API. Ez nem kerül a kliensnek.
4. Hozz létre **Map ID**-t (Map Management, JavaScript, Vector vagy Raster) és add meg `GOOGLE_MAPS_MAP_ID`-ként (a haladó markerekhez kötelező).
5. Állítsd be a `GOOGLE_GEOCODING_MONTHLY_LIMIT`-et (alap 1000) az ingyenes keret alá. Egy cím csak egyszer geokódolódik (cache), 100–120 résztvevőnél egy esemény pár száz hívás. A plafon elérése után a Nominatim (OSM) tartalék működik; a Rendszerállapot oldalon látod a havi használatot.
6. Az esemény létrehozásakor add meg a **települést** (pl. Derekegyháza): a címkeresés ezt hozzáfűzi, így elég az utca és házszám.
7. A térkép **nem** működik offline; ilyenkor a csapatnézet a listára vált, a check-in offline sor érintetlen.

A kulcsok nélkül az alkalmazás működik, de térkép nincs (a hostok pozíció nélkül jelentkezhetnek, az admin pedig csak kulcs után tudja megerősíteni a pozíciókat).

## 7. Frissítés

```bash
git pull
docker compose build app && docker compose up -d app    # a migrációk automatikusan lefutnak
```

Frissítés előtt készíts kézi mentést (Admin → Rendszerállapot → „Mentés indítása most"). A függőségeket legalább havonta (és biztonsági közlemény esetén azonnal) frissítsd: `npm audit`, majd tesztek, majd új image.

## 8. Telepítés utáni kötelező ellenőrzések

1. **Restore-teszt** – [mentes-visszaallitas.md](mentes-visszaallitas.md): `scripts/restore-test.sh`. Éles használat előtt egyszer kötelező.
2. Teszt-jelentkezés végigvitele (jelentkezés → jóváhagyás → belépés → check-in) egy telefonon Androidon és iPhone-on, **valódi GPS-szel és valódi HEIC fotóval**.
3. Rendszerállapot oldal: minden pont „Rendben" (mentés megléte, SMTP, háttérfolyamat).
4. A jogi szövegek (szabályzat, adatkezelési tájékoztató, fotózási szabályok) ellenőriztetése magyar/EU adatvédelmi szakemberrel.

## Üzemeltetési tudnivalók

- **Napló**: strukturált JSON a konténer kimenetén (`docker compose logs app`); a PIN, jelszó, token és GPS-koordináta nem kerül a naplóba. Napló-rotáció: `docker-compose.yml`-ben `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }`.
- **Háttérmunkák** (e-mail újrapróbálás, ütemezett értesítések, megőrzés, mentés) a `app` folyamatban futnak; külön folyamathoz `WORKER_IN_PROCESS=false` és `node dist/workerMain.js`.
- **Idő**: a szerver órája legyen pontos (NTP); az időzóna a megjelenítésnél Europe/Budapest.
- **Demó adatok** csak fejlesztéshez: `npm run seed -w @th/server` (éles környezetben nem fut).
