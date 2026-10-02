# Adminisztrátori útmutató

Az admin felület: `https://<domain>/admin`. Minden admin azonos jogosultságú. Belépés: e-mail + jelszó + hitelesítő alkalmazás kódja (2FA).

## Fiók

- **Aktiválás**: a meghívó e-mailben (vagy az első admin esetén a parancssori bootstrap kiírásában) kapott linken (72 óra, egyszer használható): jelszó (legalább 12 karakter, betű + szám) és 2FA beállítása. **Mentsd el a helyreállító kódokat** – egyszer használhatók, minden használatuk auditált.
- **Elfelejtett jelszó**: a belépő oldalon „Elfelejtett jelszó" → e-mailben 30 percig érvényes, egyszer használható link.
- **Elvesztett 2FA**: belépéskor „Elvesztettem a 2FA eszközöm" → helyreállító kód. Ha ez sem megvan, egy másik admin meghívhat új fiókot a régi archiválása után.
- **Új admin / archiválás**: Adminok menü. Törlés nincs: az archivált admin nem tud belépni, később visszaállítható, a korábbi naplóbejegyzései változatlanok. Saját magadat nem archiválhatod. Hibás próbálkozások után a fiók átmenetileg zárol (5 hibás próba → 15 perc).

## Egy esemény menete

1. **Események → Új esemény**: név, típus (Halloween/Húsvét – a megjelenés automatikus), leírás, szabályzat, jelentkezési időszak, **módosítási (és visszalépési) határidő**, tervezett kezdés/vége, GPS-sugár (alap 120 m), szervezői kapcsolat. A rendszer a dátumsorrendet ellenőrzi, és szerkesztéskor figyelmeztet, ha a változás a résztvevőket érintheti (jelentkezés, határidő, T−24 felfedés).
2. **Jelentkezés megnyitása** (Tervezés → Jelentkezés nyitva). A nyilvános oldal ekkor jelenik meg, a jelentkezés a lezárási időpontban magától lezárul.
3. **Jelentkezők elbírálása** (Csapatok és hostok):
   - *Csapat*: Jóváhagy / Elutasít (indok kötelező, a jelentkező e-mailben megkapja).
   - *Host*: előbb **erősítsd meg a pozíciót** (Pozíció gomb → Cím keresése → szükség esetén húzd a jelölőt → Megerősítés). Közeli állomásra a rendszer figyelmeztet (lehetséges duplikáció) – a döntés a tiéd. Utána Jóváhagy. A jóváhagyás létrehozza az „Állomás #N"-t. A host neve a csapatoknak sosem látszik.
   - Jóváhagyáskor a résztvevő e-mailben megkapja a belépési linket és a PIN-t. **A jóváhagyó levél törzse küldés után törlődik**; ha elveszett: *Új hozzáférés* (új link + új PIN, a régi munkamenetek megszűnnek) vagy *Új link* (csak a link cserélődik, a PIN és a bejelentkezett eszközök maradnak; az új link csak egyszer látszik).
   - Határidő utáni (késői) host jóváhagyásnál figyelmeztetést kapsz; csak a jóváhagyáskori adatok érvényesek.
4. **Jelentkezés lezárása** → *Előkészítés*. Ekkor véglegesedik a létszám; a módosítási határidő után a hostok e-mailben megkapják a végleges gyermek/felnőtt létszámot.
5. **T−24**: az esemény tervezett kezdése előtt 24 órával a helyszínek automatikusan láthatóvá válnak a jóváhagyott résztvevőknek (egyszeri e-mail). Korábbi indításnál az indításkor azonnal.
6. **Esemény indítása**: a függő jelentkezések *Lejárt – nem került jóváhagyásra* állapotba kerülnek (e-mail), a jóváhagyottak „elindult" értesítést kapnak, az indítás ideje (actual start) lesz a mérvadó.
7. **Az esemény alatt**: Irányítópult (automatikus frissítés), térkép, Ellenőrzés, Fotók, Értesítések.
8. **Esemény befejezése**: nincs új check-in/fotó/létszám-módosítás; az offline-ban korábban keletkezett elemek szinkronizálhatók (az eseményvég után keletkezettek review-ra kerülnek). A résztvevői hozzáférés még 7 napig él. A lezárt esemény nem nyitható újra. Lezáráskor automatikusan esemény-pillanatkép készül.
9. **Lemondás** (bármikor a lezárás előtt): indok kötelező; ha volt jelentkező, az esemény nem törölhető, csak lemondható – a résztvevők értesítést kapnak, a hozzáférések azonnal megszűnnek. Üres draft fizikailag törölhető.

## Állomások (Állomások menü)

- **Host nélküli (virtuális) állomás**: cím → geokódolás → marker → megerősítés → létrehozás. Aktív esemény közben is lehetséges: ilyenkor **minden csapatnak új kötelező feladat** (a már kész csapat újra nyitott lesz).
- **Eltávolítás**: indok kötelező; az elvárt állomásszám azonnal csökken, a résztvevők és hostok értesítést kapnak, a számozás **nem változik** (az #7 törlése után az új állomás #19, nem #7), a korábbi check-inek története megmarad.
- **Ajándék**: állomásonként a ciklusonkénti előzmények, a jelentő csapatok és időpontok (a host ezt nem látja). Kézi módosítás (Elfogyottra állít / Újra feltöltve) **indokkal**.

## Ellenőrzés (offline szinkron) és manuális check-in

Az **Ellenőrzés** menüben azok az offline check-inek jelennek meg, amelyeket a szerver nem fogadhatott el automatikusan (törölt állomás, esemény vége utáni vagy előtti időbélyeg, irreális telefonóra, távolság-eltérés, pontatlan GPS). Mindegyiknél látod az eredeti időbélyeget és a szerver fogadási idejét, valamint a hozzá tartozó várakozó fotókat.
- **Elfogad**: a teljesítés érvényes, a fotók normál módon láthatóvá válnak.
- **Elutasít**: a teljesítés nem számít, a fotók nem jelennek meg a galériában.
- **Manuális check-in**: csapat + állomás + időpont + **kötelező indoklás**; „admin által rögzített" jelölést kap, auditált.

## Fotók

- Az admin az event-szintű galériát látja (csapatnévvel, jelentésekkel). A résztvevők számára a fotók anonimak.
- **Jelentett fotó** (azonnal rejtett a résztvevők elől; e-mail értesítést kapsz): a jelentő és az ok látszik. Döntés: **Visszaállítás** (a jelentés története megmarad) vagy **Végleges törlés** (a jelentés + döntés megmarad). Harmadik lehetőség („figyelmen kívül hagyás") nincs.
- Bármely fotó törölhető (auditált).

## Megtekintés csapatként / hostként

A jelentkezők sorában a „Megtekintés csapatként/hostként" **csak olvasható** nézetet ad; innen nem lehet check-int, feltöltést, visszalépést vagy más résztvevői műveletet végezni. A megtekintés naplózódik.

## Értesítések (e-mail)

Állapotok: Elküldve / Függőben–újrapróbálás alatt / Sikertelen / Újraküldés (utolsó próbálkozás, próbák száma, rövid hibaok látszik). Egy levél legfeljebb 5 alkalommal próbálkozik. Kézi újraküldés ugyanarra a címzettre és típusra percenként legfeljebb egyszer. A linket/PIN-t tartalmazó levelek törzse küldés után törlődik, ezeket új hozzáférés kiadásával pótold.

## Audit napló

Minden jelentős művelet naplózódik (ki, mikor, mit, melyik entitás, előtte/utána értékek, indok). Szűrhető művelet, entitás, admin és időszak szerint. A napló nem módosítható és nem törölhető (az adatbázis is tiltja), és korlátlan ideig megmarad. Személyes adat csak a legszükségesebb mértékben kerül bele.

## Rendszerállapot és mentés

A Rendszerállapot oldalon összesítve: adatbázis, fotótároló, e-mail, háttérfolyamatok, mentés, kritikus hibák, verzió → *Rendben / Figyelmeztetés / Hiba*. Itt indítható kézi mentés és látható a mentések listája. A visszaállítás kézi folyamat: [mentes-visszaallitas.md](mentes-visszaallitas.md).

## Adatkezelési kérelmek

Nincs önkiszolgáló portál: a beérkező kérelmeket (hozzáférés, helyesbítés, törlés, anonimizálás) az **Adatkezelési kérelmek** menüben rögzítsd (az összefoglalóba **ne írj személyes adatot**), majd lezárd. Helyesbítés: a jelentkezők szerkesztésével. Törlés/anonimizálás: a csapat vagy host sorából indokkal (a státusz és az aggregált adat megmarad, a személyes adat törlődik; a hozzáférés megszűnik). A jogszabályi folyamatokat indulás előtt ellenőriztesd.

## Megőrzés (automatikus)

- Személyes adatok anonimizálása kb. **12 hónappal** az esemény lezárása után.
- Fotók törlése **24 hónap** után.
- Audit napló: korlátlan. Aggregált statisztika: megmarad.
- Ez operátori adatmegőrzési szabály, nem jogi állítás; indulás előtt egyeztesd szakemberrel.
