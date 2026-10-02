# Ismert korlátozások

Ezek az MVP tudatos vagy eddig fel nem oldott korlátai. A jövőbeli fejlesztési ötletek külön, az MVP-től elkülönítve: [jovobeli-fejlesztesek.md](jovobeli-fejlesztesek.md).

## Még nem igazolt (éles előtt kézzel ellenőrizendő)

1. **Valódi eszközök**: Android Chrome és iPhone Safari – valódi GPS-pontosság, telepített PWA, iOS-es offline és szinkron-viselkedés – nincs végigpróbálva. A Playwright-tesztek emulált helymeghatározást és hálózat-kikapcsolást használnak.
2. **HEIC/HEIF fotók**: a feldolgozás WASM dekóderrel (`heic-decode`) történik, mert a `sharp` előre fordított változata HEIC-et nem olvas. A hibás bemenet elutasítása tesztelt, de **valódi iPhone-os HEIC fotóval nem próbáltuk** (nincs HEIC-kódoló a fejlesztői környezetben). Nagy (12+ MP) HEIC-képeknél a dekódolás lassabb és memóriaigényesebb lehet; a kliens a nem-HEIC képeket feltöltés előtt kicsinyíti, a HEIC-et az eredeti formájában küldi.
3. **SMTP szolgáltató** és a levelek kézbesíthetősége (spam-szűrők, SPF/DKIM/DMARC a feladó domainre) – az üzemeltető dolga beállítani és kipróbálni.
4. **Valódi katasztrófa-helyreállítás gyakorlása** – a `restore-test.sh` igazolja a mentés–visszaállítás technikai körforgását (pg_dump → pg_restore, triggerek és megkötések megmaradnak), a teljes éles folyamat gyakorlása üzemeltetői feladat.
5. **Jogi szövegek** (szabályzat, adatkezelési tájékoztató, fotózási szabályok) – a mellékelt szövegek tájékoztató jellegűek; indulás előtt magyar/EU adatvédelmi szakemberrel ellenőriztetendők. A megőrzési idők (12/24 hónap) operátori policy, nem jogi állítás.

## Működési korlátok

6. **Host pozíciójának megerősítése**: jelentkezéskor a hostnak még nincs munkamenete, ezért a pozíciót az admin erősíti meg a jóváhagyás előtt (a jóváhagyás csak megerősített pozícióval megy). A host belépés után maga is finomíthatja.
7. **Pontatlan GPS határa**: 100 m (`MAX_ACCURACY_M`) – a spec nem rögzítette. Rosszabb pontosságnál a rendszer nem dönt, a csapatnak újra kell próbálnia (offline ág: review).
8. **Offline GPS-újraellenőrzés**: a szerver csak úgy tud újraellenőrizni, ha a szinkron kérés ideiglenesen tartalmazza a koordinátát (nem tárolt, nem naplózott, de az átvitel idejére létezik). Alternatíva (kevésbé biztonságos): csak kliens-számolt távolság.
9. **Eseményvég és szinkron**: a lezárás utáni szinkron a résztvevői hozzáférés lejáratáig (7 nap) lehetséges; ez után az offline sor tartalma a telefonon marad, de nem szinkronizálható.
10. **iOS háttér-szinkron**: nincs (nem ígérjük); az app megnyitásakor / online eseménykor / kézi gombra szinkronizál. A böngésző a helyi tárolást (IndexedDB) kiürítheti – ezért a felület figyelmeztet, hogy a szinkronra váró adatokat nem szabad törölni; tartósságot a böngésző nem garantál korlátlanul.
11. **Érzékeny e-mailek újraküldése**: a belépési linket/PIN-t tartalmazó levél törzse küldés után törlődik (adatvédelmi okból), ezért kézi „újraküldés" helyett új hozzáférést kell kiadni (új link + új PIN) vagy csak új linket.
12. **Egy host – egy állomás**: egy host-jelentkezés egy címet jelent; több cím = több jelentkezés (a spec szerint).
13. **Késői jóváhagyás**: csapat/host jóváhagyása az esemény indítása után nem lehetséges (a függő jelentkezés lejár); új állomást ilyenkor az admin hozhat létre host nélkül.
14. **Publikus OSM csempe és Nominatim**: használati szabályzatuk szerint nem korlátlan éles szolgáltatások (cache és rate limit van, de nagyobb forgalomnál szolgáltatót kell váltani).
15. **Egyetlen szerverpéldány**: a rate limit és a háttérmunkák adatbázis-alapúak (több példányon is helyesek), de az SSE kapcsolatok folyamatonként élnek – több app-példány esetén egy szerveren kiváltott eseményről a másik példány kliensei csak a következő frissítéskor (újracsatlakozás/újratöltés) értesülnek. A célméretnél (egy példány) ez nem jelent problémát.
16. **Mentés**: nincs folyamatos (WAL) archiválás; legrosszabb esetben a legutóbbi mentés óta eltelt idő veszik el. Az admin felületen nincs visszaállítás gomb (szándékosan).
17. **Admin felület mobilon**: használható, de elsődlegesen asztali böngészőre készült.
18. **Akadálymentesség**: alapszintű, nincs formális WCAG audit; a térkép billentyűzetes használata korlátozott (a lista nézet a teljes értékű alternatíva).
19. **Nyelv**: csak magyar felület és e-mail; nincs többnyelvűség.
20. **Admin-szerkesztés korlátai**: az admin csapat-adatokat (név, kapcsolattartó, telefon, tagok) és host-adatokat szerkeszthet; csapat e-mail-címe csak a résztvevő megerősítésével változik.
