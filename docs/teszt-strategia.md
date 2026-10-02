# Tesztstratégia

## Rétegek és futtatás

| Réteg | Eszköz | Hol | Futtatás |
|---|---|---|---|
| Egységteszt (közös szabályok) | Vitest | `packages/shared` | `npm test -w @th/shared` |
| Szerver egység- és integrációs tesztek | Vitest + valódi PostgreSQL | `apps/server/test` | `npm test -w @th/server` |
| Kliens (offline sor) | Vitest + fake-indexeddb | `apps/web/src/**/*.test.ts` | `npm test -w @th/web` |
| E2E (valódi böngésző) | Playwright (Chromium) | `e2e/tests` | `npm run test:e2e` |
| Restore-teszt | shell + valódi `pg_dump` | `scripts/restore-test.sh` | telepítés után, lásd [mentes-visszaallitas.md](mentes-visszaallitas.md) |
| Típusellenőrzés | `tsc --noEmit` | minden csomag | `npm run typecheck` |

Az integrációs tesztek **valódi PostgreSQL-lel** futnak (nem mock), hogy a megkötéseket, triggereket és tranzakciókat is ellenőrizzék. Előfeltétel egy elérhető tesztadatbázis, alapból `postgres://th:th@localhost:5433/th_test` (`TEST_DATABASE_URL`-lel felülírható), pl.:

```bash
docker run -d --name th-test-db -e POSTGRES_USER=th -e POSTGRES_PASSWORD=th -e POSTGRES_DB=th_test -p 5433:5432 postgres:16-alpine
```

Az E2E teszt saját adatbázist (`th_e2e`) hoz létre a tesztadatbázis-szerveren (port 5433), saját szervert indít (3077-es port) a lefordított klienssel (`npm run build -w @th/web` előtte kell), és Chromiumot használ (`npx playwright install chromium`).

## Mit fednek le a tesztek (spec §91 szerint)

**Egységtesztek**: esemény-életciklus és átmenetek, határidők és dátumsorrend, T−24 számítás (korábbi indítással), PIN-szabályok (triviális PIN-ek), telefon-normalizálás, haversine távolság/sugár, állomásszám-kiosztás (nem használódik újra), ajándék-küszöb (3 különböző csapat), access token érvénytelenítés, PIN-csere → munkamenetek megszűnése, értesítés-deduplikáció.

**Integrációs tesztek (szerver)**:
- jelentkezés → jóváhagyás/elutasítás; idempotencia (párhuzamos dupla beküldés); gyermek-követelmény (adatbázis-trigger); csapatnév/cím egyediség; módosítás és visszalépés (határidővel); e-mail-csere; PIN-helyreállítás (azonos válasz ismeretlen címre);
- host címváltozás → újra jóváhagyás; állomás létrehozás/eltávolítás; T−24 felfedés; közeli állomás figyelmeztetés; virtuális állomás;
- check-in (belül/kívül/pontatlan, idempotens, párhuzamos); manuális check-in; játékidő és haladás (új/eltávolított állomás, esemény vége);
- ajándék-ciklus (3 jelzés, újratöltés, host nem látja a jelentőket);
- fotó: feltöltés, tartalom-ellenőrzés, hamis fájl, dekompressziós bomba, 20 MB határ, 5 fotó határ párhuzamosan, EXIF-törlés, anonimitás, jelentés → elrejtés → visszaállítás/törlés;
- esemény: lemondás (indok, hozzáférés-visszavonás), lezárás utáni hozzáférés-lejárat, indításkori jelentkezés-lejárat, egyszerre egy aktív esemény;
- admin: belépés, 2FA, helyreállító kód, zárolás, archiválás, audit nem módosítható, CSRF, statisztika, audit-szűrés, rendszerállapot, mentés (napi/pillanatkép/megőrzés), adatmegőrzés (hozzáférés-lejárat, anonimizálás, fotótörlés), adatkezelési kérelem, megtekintés-mint (csak olvasható);
- e-mail: outbox, újrapróbálás, dedup, kézi újraküldés (percenként egyszer), érzékeny törzs törlése küldés után, sablonok (HTML-escape).

**Offline tesztek** (szerver + kliens):
- szerver: egy/több offline check-in, duplikált szinkron, egy hibás elem nem blokkol, ismeretlen állomás elutasítva, eseményvég előtti (elfogadott) és utáni (review) időbélyeg, irreális óra, törölt állomás → review → elfogadás/elutasítás, új állomás, offline fotó + törölt állomás (várakozó fotó, elbírálás), idempotens fotó szinkron;
- kliens: sor, hálózati hiba, részleges siker, review/elutasítás értesítés, fotó-hibák, „check-in előtt a fotó vár", tárhelyhiba (a korábbi elemek megmaradnak), lejárt munkamenet (401), kézi elvetés.

**E2E** (`e2e/tests/flow.spec.ts`): admin aktiválás 2FA-val és belépés → esemény létrehozás/megnyitás → csapat- és host-jelentkezés a nyilvános oldalon → pozíció megerősítés és jóváhagyás → esemény indítás → belépés a levélben kapott linkkel/PIN-nel → online check-in → fotó → **offline** check-in (hálózat kikapcsolva) → helyreállítás és automatikus szinkron → admin irányítópult és audit napló.

## Ismert lyukak a tesztekben (őszintén)

- **Valódi eszközök**: Android Chrome és iPhone Safari – valódi GPS, valódi HEIC fotó, telepített PWA, iOS-es offline viselkedés – **kézzel tesztelendő** éles használat előtt. A Playwright csak emulált helymeghatározást és hálózat-kikapcsolást használ.
- **Valódi SMTP szolgáltató** és valódi Google Maps/Geocoding/Directions hívás és a Nominatim nincs tesztelve (a geokódoló mockolt, a térkép az E2E-ben nem töltődik be; a tartalék utak le vannak fedve). A térképet, a húzható markert és az útvonal-optimalizálást valódi kulccsal kézzel kell kipróbálni.
- **Terheléses teszt** nincs (a célméret ~100–120 résztvevő).
- Az E2E jelenleg egyetlen, hosszú forgatókönyv; a T−24 felfedés, az admin manuális check-in, a fotó-moderáció és az esemény-lemondás böngészős E2E-je szerveroldalon (integrációs szinten) le van fedve, de UI-szinten nem.
- Akadálymentesség: nincs formális WCAG audit (spec szerint nem MVP); kézi ellenőrzési lista a biztonsági checklist végén.
