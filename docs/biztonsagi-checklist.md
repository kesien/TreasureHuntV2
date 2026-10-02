# Biztonsági checklist

Állapot a kódban (✅ megvalósítva és tesztelve, 🟡 részben / üzemeltetői teendő, ⬜ nincs). Az „Üzemeltetői teendő" oszlop a telepítéskor elvégzendő.

## Spec §76 – biztonsági alapok

| Követelmény | Állapot | Megvalósítás / megjegyzés |
|---|---|---|
| HTTPS | 🟡 | Reverse proxy végzi ([telepites.md](telepites.md)); production módban `upgrade-insecure-requests` CSP. **Üzemeltetői teendő.** |
| Secure süti | ✅ | `NODE_ENV=production` esetén `Secure` (HTTP-n éles módban a belépés nem működik). |
| HttpOnly süti, SameSite | ✅ | Minden munkamenet-süti `HttpOnly; SameSite=Lax`. |
| CSRF védelem | ✅ | Cookie-s munkamenetnél állapotváltoztató kérésekhez kötelező `X-CSRF-Token` (munkamenetenként véletlen, időzítés-biztos összehasonlítás); teszt: `auth.test.ts`. A munkamenet nélküli (publikus) végpontok rate limitelt, CSRF-érzéketlen műveletek. |
| CSP és biztonsági fejlécek | ✅ | `@fastify/helmet`: `default-src 'self'`, szkript csak saját, `frame-ancestors 'none'`, `object-src 'none'`, `nosniff`, HSTS (production). A CSP a Google Maps JS API forrásait engedi (`maps.googleapis.com`, `maps.gstatic.com`, `*.ggpht.com`). |
| Bemenet-ellenőrzés | ✅ | Minden végpont zod-sémával; telefon/PIN/dátum szabályok a közös csomagban. |
| SQL injection | ✅ | Paraméterezett lekérdezések (Drizzle); a kézi `sql` sablonok is paraméterezettek. |
| XSS | ✅ | React alapból escape-el; nincs `dangerouslySetInnerHTML`; e-mail HTML-ben minden dinamikus érték escape-elt (teszt). |
| Rate limiting, brute force | ✅ | Adatbázis-alapú csúszóablak: admin belépés (IP + e-mail), PIN belépés (IP + hozzáférésenként zárolás), PIN/jelszó helyreállítás, admin meghívás/reset, e-mail csere, geokódolás, check-in, szinkron, fotófeltöltés, fotójelentés, kézi e-mail újraküldés. A mobilhálózati közös IP miatt a határok bőkezűek (IP szinten 30 PIN próba/15 perc), a valódi védelmet a hozzáférésenkénti zárolás (5 hibás PIN → 10 perc) adja. |
| PIN / jelszó / token nem kerül logba | ✅ | Pino redact + a kérések naplózása törzs és fejlécek nélkül, az URL tokenjei kitakarva (`/belepes/[REDACTED]`, `?token=[REDACTED]`); teszt: `logging.test.ts`. A GPS-koordináta sem naplózódik. |
| Access token hash-elve | ✅ | Csak SHA-256 hash tárolt; 256 bites véletlen (`crypto.randomBytes`); nem szekvenciális, nem tartalmaz személyes adatot. |
| PIN / jelszó tárolás | ✅ | argon2id. Triviális PIN-ek tiltva. |
| Admin 2FA | ✅ | Kötelező TOTP; helyreállító kódok hash-elve, egyszer használhatók, használatuk auditált. A TOTP titok `APP_SECRET`-ből származtatott AES-256-GCM kulccsal titkosítva. |
| Feltöltés-ellenőrzés | ✅ | Tartalom alapú típusellenőrzés (nem kiterjesztés), 20 MB, hamis/megcsonkított fájl elutasítva. |
| Képfeldolgozási korlátok | ✅ | 64 MP pixelkorlát (dekompressziós bomba), egyszerre 2 feldolgozás, EXIF/GPS törlés, újrakódolás; a fotók elérése jogosultság-ellenőrzéssel, `nosniff`. |
| Éles hibaválasz stack trace nélkül | ✅ | Egységes magyar hibaüzenet; a 500-as hibák rövid, PII nélküli bejegyzésként az adminnak látszanak. |
| Függőségfrissítési stratégia | 🟡 | `npm audit --omit=dev` jelenleg **0 ismert sérülékenység** (a drizzle-orm és react-router frissítve). **Üzemeltetői teendő:** havonta `npm audit` + `npm outdated`, biztonsági közleménynél azonnal; frissítés után tesztek és új image. |
| Docker minimális jogosultság | ✅ | Nem root felhasználó (`node`), `cap_drop: [ALL]`, `no-new-privileges`, a port csak localhost-on; a konténer a `/data` volume-on kívül nem ír. |

## Egyéb védelmek

| Terület | Állapot | Megjegyzés |
|---|---|---|
| Audit napló | ✅ | Hozzáfűzhető: adatbázis-trigger tiltja a módosítást/törlést; kulcsszavas PII-szűrés (pin/jelszó/token/hash mezők sosem kerülnek bele). |
| Hozzáférés-ellenőrzés | ✅ | Minden résztvevői művelet szerveroldalon ellenőrzi az esemény/résztvevő státuszát, határidőt, állomás-állapotot és jogosultságot; a kliens csak megjelenít. |
| Adatvédelem / minimalizálás | ✅ | Nincs születési dátum, folyamatos GPS vagy csapat-helyzet; a pontos GPS nem tárolt; a host neve sosem látszik; a T−24 előtti helyszín nem szivárog (teszt). |
| Munkamenet-kezelés | ✅ | Admin: 8 óra inaktivitás; résztvevő: eszközönkénti, PIN-csere/-helyreállítás minden munkamenetet megszüntet; esemény lezárás +7 nap / lemondás: hozzáférés megszűnik. |
| Google API-kulcsok | 🟡 | A böngészőkulcs publikus, ezért **referrer-korlátozás kötelező**; a szerverkulcs IP-korlátozott, és nincs a kliensnek kiadva. Havi plafon + Cloud Console költségkeret/riasztás. **Üzemeltetői teendő.** |
| Titkok | 🟡 | `APP_SECRET`, `DB_PASSWORD`, SMTP-jelszó: a `.env` nincs a repositoryban; az SMTP-jelszó titkosítva tárolt. **Üzemeltetői teendő:** `.env` jogosultságok (600), titok-mentés a szerveren kívül. |
| Mentések | 🟡 | Tartalmaznak személyes adatot; **üzemeltetői teendő:** a célhely védelme / titkosítása. |
| SSE | ✅ | Csak „változott" jelzés, adatot nem hordoz; az adat a jogosultság-ellenőrzött API-ból jön. |
| Szolgáltatás-megtagadás | 🟡 | Rate limit + méretkorlátok (JSON 1 MB, fotó 20 MB); a reverse proxy-n célszerű kapcsolat- és kéréskorlát. |

## Telepítés előtti ellenőrzőlista

- [ ] `NODE_ENV=production`, `PUBLIC_BASE_URL` HTTPS
- [ ] Erős, véletlen `APP_SECRET` és `DB_PASSWORD`; `.env` csak az üzemeltető által olvasható
- [ ] A 3000-es port nincs kitéve; csak a reverse proxy érhető el
- [ ] Első admin 2FA-val, helyreállító kódok mentve
- [ ] SMTP működik (teszt levél), az Értesítések oldalon nincs sikertelen elem
- [ ] **Restore-teszt lefuttatva** ([mentes-visszaallitas.md](mentes-visszaallitas.md))
- [ ] Mentési célhely a szerveren kívülre is másolva
- [ ] Valódi telefonokon kipróbálva: GPS, offline, HEIC fotó, telepítés
- [ ] Szabályzat, adatkezelési tájékoztató, fotózási szabályok jogi ellenőrzése
- [ ] `npm audit --omit=dev` tiszta

## Akadálymentesség – kézi ellenőrzési lista (nem formális WCAG audit)

Megvalósítva: kontrasztos színek világos/sötét témában, az állapot nem csak színnel jelenik meg (számok, ikonok, szöveges címkék, szaggatott/ikonos jelölés), látható fókusz, minden mezőhöz `label`, minimum 44–48 px érintési célok, billentyűzettel használható admin (Esc a párbeszédablakokra), `aria-live` állapotüzenetek, `alt` szöveg a fotókon, érthető hibaüzenetek. Hiányzik: formális WCAG audit, képernyőolvasós végigpróbálás, térkép billentyűzetes használata (a lista nézet a teljes értékű alternatíva).
