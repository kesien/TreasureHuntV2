# Mentés és visszaállítás

## Mit ment a rendszer

| Mentés | Mikor | Tartalom | Megőrzés |
|---|---|---|---|
| Napi | automatikusan, ha az utolsó sikeres 24 óránál régebbi (a háttérfolyamat óránként ellenőrzi) | adatbázis (`pg_dump`, custom formátum) + fotók (`tar.gz`) **külön fájlban** | legalább 7 nap (`BACKUP_DAILY_RETENTION_DAYS`) |
| Kézi | Admin → Rendszerállapot → „Mentés indítása most" | ugyanaz | mint a napi |
| Esemény-pillanatkép | az esemény lezárása után automatikusan (egyszer) | teljes adatbázis + fotók | hosszabb ideig (`BACKUP_SNAPSHOT_RETENTION_DAYS`, alap 730 nap) |

- A fájlok a `BACKUP_DIR` könyvtárba kerülnek (`daily/`, `snapshots/`). Ez bármilyen mountolt tárhely lehet (külső lemez, NAS, rclone-nal szinkronizált mappa) – **a mentési célt érdemes a szerverrel azonos gépen kívülre is másolni** (ugyanazon lemez hibája mindkettőt elvinné).
- A sikertelen mentés rögzül (Rendszerállapot oldal: figyelmeztetés), hibás kísérlet után 30 percig nem ismétlődik. Az utolsó sikeres mentés soha nem törlődik a megőrzési takarításkor.
- Az `APP_SECRET` **nem része a mentésnek** – külön, biztonságosan őrizd. Nélküle az SMTP-jelszó és a 2FA titkok nem állíthatók vissza.
- A mentés tartalmaz személyes adatot; védd a célhelyet, és vedd figyelembe az adatmegőrzési szabályokat (a 12 hónap utáni anonimizálás a régi mentésekre nem hat vissza – a mentések saját lejárata számít).

## Restore-teszt (telepítés után kötelező)

A `scripts/restore-test.sh` egy friss mentést **egy másik adatbázisba** állít vissza, összeveti a táblák sorszámát, és ellenőrzi a fotók archiválás–kicsomagolás körforgását. A működő adatbázist nem módosítja.

```bash
DB_CONTAINER=$(docker compose ps -q db) SRC_DB=th PHOTO_DIR=/path/a/fotokhoz ./scripts/restore-test.sh
```

Sikeres futás kimenete: `OK: 26 tábla, összesen N sor egyezik` … `Restore-teszt sikeres.`

## Éles visszaállítás (katasztrófa esetén)

Az admin felületen szándékosan **nincs „Restore" gomb** (veszélyes, véletlenül kiváltható). A visszaállítás kézi, tudatos folyamat:

1. **Állítsd le az alkalmazást**, hogy ne írjon az adatbázisba:
   ```bash
   docker compose stop app
   ```
2. **Válaszd ki a mentést** a `BACKUP_DIR`-ben (pl. `daily/daily-2026-10-02T03-00-00-000Z.db.dump` és a hozzá tartozó `.photos.tar.gz`).
3. **Adatbázis visszaállítása** (üres adatbázisba):
   ```bash
   docker compose exec db psql -U th -d postgres -c "drop database if exists th with (force)" -c "create database th"
   docker compose cp /path/a/mentes.db.dump db:/tmp/restore.dump
   docker compose exec db pg_restore -U th -d th --no-owner /tmp/restore.dump
   ```
4. **Fotók visszaállítása**:
   ```bash
   docker compose run --rm --no-deps -v /path/a/mentes.photos.tar.gz:/restore/photos.tar.gz:ro app \
     sh -c "rm -rf /data/photos/* && tar -xzf /restore/photos.tar.gz -C /data/photos"
   ```
   (a `photos` volume tartalma kerül cserére)
5. **Indítsd el** az alkalmazást: `docker compose up -d app`. A migrációk automatikusan lefutnak (a mentés régebbi sémaverziója is frissül).
6. **Ellenőrizd**: belépés adminként, Rendszerállapot, egy fotó megnyitása, a jelentkezők száma.
7. Rögzítsd a visszaállítást (dátum, ok, melyik mentésből) az üzemeltetési naplóban. Az audit napló a mentés időpontjáig áll vissza; a mentés utáni események elvesztek – szükség esetén kézzel pótolandók.

Ha az `APP_SECRET` megváltozott a mentés óta: az admin felületen az SMTP-t újra be kell állítani, és minden admin 2FA-ját újra kell regisztrálni (az üzemeltető új meghívót küld).

## Tudatos korlátok

- Nincs folyamatos (WAL-alapú) archiválás: a legrosszabb adatvesztés a legutóbbi mentés óta eltelt idő (alapból legfeljebb ~24 óra, kézi mentéssel csökkenthető). Esemény közben célszerű óránként kézi mentést indítani, vagy a napi mentést sűríteni.
- A restore-teszt a teljes PostgreSQL-folyamatot ellenőrzi (triggerek, megkötések), de a **valódi katasztrófa-helyreállítás gyakorlása** az üzemeltető feladata.
