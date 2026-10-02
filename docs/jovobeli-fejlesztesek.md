# Javasolt későbbi fejlesztések

**Ezek nem részei az MVP-nek.** A specifikáció szerint az MVP-be nem kerülhet olyan funkció, amelyre nincs üzleti szükség; az alábbiak csak ötletek, amelyeket egy esemény tapasztalatai után érdemes mérlegelni.

## Üzemeltetés és megbízhatóság

- **Folyamatos mentés** (WAL-archiválás / pgBackRest) és automatikus, ütemezett restore-teszt riasztással.
- **Saját csempeszerver és geokódoló** (pl. Protomaps/OpenMapTiles + Nominatim/Photon) a publikus OSM-szolgáltatások helyett; offline térkép-csomag előtöltése az eseményterületre.
- **Egyszerű metrika-végpont** és külső uptime-figyelés (nem Grafana/Prometheus, csak egy health + riasztás e-mailben).
- **Több példányos SSE** (Postgres `LISTEN/NOTIFY`) ha valaha több app-példány kellene.
- **Titokkezelés**: Docker secrets / külső titokkezelő az `.env` helyett.

## Résztvevői élmény

- **Web Push értesítés** (T−24, elfogyott ajándék) – a spec szerint MVP-ben nincs; iOS-en csak telepített PWA-val működik.
- **Jobb offline térkép** (csempék előtöltése a jóváhagyott állomások környékére T−24 után).
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
