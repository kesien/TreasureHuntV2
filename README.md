# Kincsvadászat – szezonális közösségi esemény PWA

Saját szerveren futó, mobil-first PWA egy kisvárosi, szezonális esemény (Halloween/Húsvét) szervezéséhez: csapatok járják az állomásokat (házigazdák), GPS-alapú „Megérkeztünk" check-innel és fotókkal, offline-tűrő módon. Admin felület a teljes életciklus kezeléséhez. Magyar nyelvű; nincs verseny, ranglista vagy élő követés.

**Állapot:** az MVP megvalósítva (M1–M8). Éles használat előtt lásd: [Ismert korlátozások](docs/ismert-korlatok.md) és a [Biztonsági checklist](docs/biztonsagi-checklist.md) – különösen a valódi eszközökön végzett kipróbálást és a restore-tesztet.

## Gyors indítás (üzemeltetés)

```bash
cp .env.example .env        # állítsd be: NODE_ENV=production, PUBLIC_BASE_URL, APP_SECRET, DB_PASSWORD
docker compose up -d --build
docker compose exec app npm run admin:bootstrap -- admin@pelda.hu "Teljes Név"   # első admin, aktivációs link
```

HTTPS-hez reverse proxy kell – részletek: [docs/telepites.md](docs/telepites.md).

## Fejlesztés

Követelmény: Node 22+, Docker (PostgreSQL-hez).

```bash
npm install
docker run -d --name th-dev-db -e POSTGRES_USER=th -e POSTGRES_PASSWORD=th -e POSTGRES_DB=th -p 5432:5432 postgres:16-alpine
cp .env.example .env
npm run dev                 # szerver (http://localhost:3000); a migrációk automatikusak
npm run dev -w @th/web      # kliens fejlesztői szerver (Vite, proxy az API-ra)
npm run seed -w @th/server  # demó adatok (csak fejlesztéshez; kiírja a belépési adatokat)
```

| Parancs | Mit csinál |
|---|---|
| `npm run build` | közös csomag + szerver + kliens fordítása |
| `npm test` | egység- és integrációs tesztek (tesztadatbázis kell, lásd [docs/teszt-strategia.md](docs/teszt-strategia.md)) |
| `npm run test:e2e` | böngészős E2E (előtte `npm run build -w @th/web`) |
| `npm run typecheck` | típusellenőrzés |
| `node scripts/gen-docs.mjs` | API- és adatbázis-dokumentáció újragenerálása a kódból |
| `./scripts/restore-test.sh` | mentés–visszaállítás próba ([docs/mentes-visszaallitas.md](docs/mentes-visszaallitas.md)) |

## Felépítés

```
apps/server     Fastify API + háttérmunkák (e-mail, ütemezés, megőrzés, mentés), Drizzle migrációk
apps/web        React PWA (résztvevői és admin felület, offline sor, térkép)
packages/shared közös szabályok: PIN, telefon, geo, életciklus, státuszok
e2e             Playwright tesztek
scripts         restore-teszt, dokumentáció-generálók
docs            dokumentáció (lásd lent)
```

## Dokumentáció

| Dokumentum | Tartalom |
|---|---|
| [Architektúra](docs/architektura.md) | felépítés, technológiai döntések, állapotgépek, offline és auth modell, spec-ellentmondások kezelése |
| [Adatbázis séma](docs/adatbazis.md) | táblák, megkötések (generált) |
| [API](docs/api.md) | végpontok, jogosultságok (generált) |
| [Telepítés](docs/telepites.md) | Docker, HTTPS, első admin, SMTP, frissítés |
| [Környezeti változók](docs/kornyezeti-valtozok.md) | teljes lista |
| [Mentés és visszaállítás](docs/mentes-visszaallitas.md) | mentési rend, restore-teszt, éles visszaállítás |
| [Admin útmutató](docs/admin-utmutato.md) | az esemény menete és az admin funkciók |
| [Résztvevői útmutató](docs/resztvevoi-utmutato.md) | csapatok és hostok; GPS-hibaelhárítás |
| [Tesztstratégia](docs/teszt-strategia.md) | rétegek, lefedettség, ismert lyukak |
| [Biztonsági checklist](docs/biztonsagi-checklist.md) | állapot és telepítés előtti lista |
| [Ismert korlátozások](docs/ismert-korlatok.md) | mi nincs még igazolva / mit nem tud |
| [Javasolt későbbi fejlesztések](docs/jovobeli-fejlesztesek.md) | az MVP-től elkülönítve |

## Jogi megjegyzés

A szabályzat, az adatkezelési tájékoztató, a fotózási szabályok és az adatmegőrzési idők (személyes adat ~12 hónap, fotó 24 hónap, audit korlátlan) **operátori policy, nem jogi állítás**; indulás előtt magyar/EU adatvédelmi szakemberrel ellenőriztetendők.
