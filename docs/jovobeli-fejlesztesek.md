# Javasolt későbbi fejlesztések

**Ezek nem részei az MVP-nek.** A specifikáció szerint az MVP-be nem kerülhet olyan funkció, amelyre nincs üzleti szükség; az alábbiak csak ötletek, amelyeket egy esemény tapasztalatai után érdemes mérlegelni.

## Üzemeltetés és megbízhatóság

- **Folyamatos mentés** (WAL-archiválás / pgBackRest) és automatikus, ütemezett restore-teszt riasztással.
- **Routes API** a (legacy) DirectionsService helyett; saját/alternatív geokódoló (pl. hazai címadatbázis), ha a Google feltételek vagy költség nem megfelelő.
- **Egyszerű metrika-végpont** és külső uptime-figyelés (nem Grafana/Prometheus, csak egy health + riasztás e-mailben).
- **Több példányos SSE** (Postgres `LISTEN/NOTIFY`) ha valaha több app-példány kellene.
- **Titokkezelés**: Docker secrets / külső titokkezelő az `.env` helyett.

## Résztvevői élmény

- **Web Push értesítés** (T−24, elfogyott ajándék) – a spec szerint MVP-ben nincs; iOS-en csak telepített PWA-val működik.
- **Offline térkép**: a Google Maps nem cache-elhető; offline térképhez más csempeszolgáltató kellene (jelenleg offline a lista a tartalék).
- **Fotók kliensoldali HEIC→JPEG átalakítása** (ha a böngésző támogatja), hogy offline kevesebb helyet foglaljon.
- **Telepítési felszólítás** (add-to-homescreen javaslat) iOS/Android útmutatóval.
- **Többnyelvűség** (angol/német) turisták vagy vendégek számára.

## Adminisztráció

- **Szerepkörök** (pl. csak olvasó, fotó-moderátor) – az MVP-ben minden admin azonos jogú.
- **Tömeges műveletek** a jelentkezőknél (csoportos jóváhagyás/e-mail).
- **Exportok** (CSV a résztvevői statisztikáról, esemény-összefoglaló PDF).
- **Sablonok szerkesztése** az admin felületről (jelenleg kódban vannak, egységes arculattal).
- **Rate limit értékek** beállítása a felületről.
- **Önkiszolgáló adatkezelési portál** (hozzáférés/törlés kérése) – jogi egyeztetés után.

## Technikai

- **E2E bővítés**: T−24 felfedés, admin manuális check-in, fotó-moderáció, esemény-lemondás böngészős tesztjei; valódi eszközfarm (BrowserStack/Playwright iOS) a Safari-ellenőrzéshez.
- **Terheléses teszt** nagyobb eseményhez.
- **Szolgáltatói absztrakciók bővítése**: több geokódoló (pl. saját + tartalék), levélküldő API-adapter az SMTP mellett.
- **Kódmegosztás az API típusaihoz** (OpenAPI séma generálása a zod-sémákból), hogy az API-dokumentáció teljes (kérés/válasz) legyen.
- **Szkennelés feltöltéskor** (víruskereső) – ha a használati környezet indokolja.
