#!/usr/bin/env bash
# Restore-teszt: éles-szerű mentés visszaállítása EGY MÁSIK adatbázisba, majd a táblák sorszámainak és a
# fotók tartalmának összevetése. A forrás adatbázist nem módosítja.
#
# Használat (Docker Compose-szal):
#   DB_CONTAINER=$(docker compose ps -q db) SRC_DB=th ./scripts/restore-test.sh
# Opcionális: PHOTO_DIR=./data/photos (a fotók tar.gz körforgásának ellenőrzéséhez)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Windows Git Bash: ne alakítsa át a konténeren belüli útvonalakat

C="${DB_CONTAINER:?Add meg a DB_CONTAINER-t (docker compose ps -q db)}"
SRC="${SRC_DB:-th}"
REST="${RESTORE_DB:-th_restore_test}"
U="${PGUSER:-th}"
DUMP=/tmp/restore-test.dump

count_sql="select table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text
           from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"

echo "1/5 Mentés (pg_dump, custom formátum)…"
docker exec "$C" pg_dump -U "$U" -Fc -d "$SRC" -f "$DUMP"

echo "2/5 Üres célabázis létrehozása: $REST"
docker exec "$C" psql -U "$U" -d postgres -q -c "drop database if exists $REST with (force)" -c "create database $REST"

echo "3/5 Visszaállítás (pg_restore)…"
docker exec "$C" pg_restore -U "$U" -d "$REST" --no-owner "$DUMP"

echo "4/5 Táblák sorszámának összevetése…"
A=$(docker exec "$C" psql -U "$U" -d "$SRC" -At -c "$count_sql")
B=$(docker exec "$C" psql -U "$U" -d "$REST" -At -c "$count_sql")
if [ "$A" != "$B" ]; then
  echo "HIBA: a sorszámok eltérnek"; diff <(echo "$A") <(echo "$B") || true; exit 1
fi
echo "$A" | awk '{n+=$2} END {print "OK: " NR " tábla, összesen " n " sor egyezik"}'

if [ -n "${PHOTO_DIR:-}" ] && [ -d "$PHOTO_DIR" ]; then
  echo "5/5 Fotók archiválása és kicsomagolása…"
  T=$(mktemp -d)
  tar -czf "$T/photos.tar.gz" -C "$PHOTO_DIR" .
  mkdir "$T/out" && tar -xzf "$T/photos.tar.gz" -C "$T/out"
  diff -r "$PHOTO_DIR" "$T/out" && echo "OK: a fotók tartalma azonos"
  rm -rf "$T"
else
  echo "5/5 Fotók: kihagyva (nincs PHOTO_DIR)"
fi

docker exec "$C" psql -U "$U" -d postgres -q -c "drop database $REST with (force)"
docker exec "$C" rm -f "$DUMP"
echo "Restore-teszt sikeres."
