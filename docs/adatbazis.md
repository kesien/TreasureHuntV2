# Adatbázis séma

> Automatikusan generált (`node scripts/gen-docs.mjs`) a `apps/server/src/db/schema.ts` alapján. A kézzel írt üzleti megkötések a lap alján vannak.

Időbélyegek UTC-ben (`timestamptz`). Migrációk: `apps/server/drizzle/` (Drizzle), induláskor automatikusan lefutnak.

## admins

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| email | text | not null |
| display_name | text | not null |
| password_hash | text |  |
| totp_secret_enc | text | — APP_SECRET-tel titkosítva |
| totp_confirmed | boolean | not null default false |
| status | text | not null default "invited" — invited | active | archived |
| failed_logins | integer | not null default 0 |
| locked_until | timestamptz |  |
| created_at | timestamptz | not null, default now |
| archived_at | timestamptz |  |

Megkötések / indexek: `admins_email_uq` (egyedi)

## admin_tokens

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| admin_id | uuid | not null → admins.id |
| kind | text | not null — invitation | password_reset |
| token_hash | text | not null unique |
| expires_at | timestamptz | not null |
| used_at | timestamptz |  |
| created_at | timestamptz | not null, default now |

## admin_recovery_codes

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| admin_id | uuid | not null → admins.id |
| code_hash | text | not null |
| used_at | timestamptz |  |

## admin_sessions

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| admin_id | uuid | not null → admins.id |
| token_hash | text | not null unique |
| csrf_token | text | not null |
| created_at | timestamptz | not null, default now |
| last_seen_at | timestamptz | not null default now |
| expires_at | timestamptz | not null |

## events

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| name | text | not null |
| type | text | not null — halloween | easter |
| short_description | text | not null default "" |
| rules | text | not null default "" |
| status | text | not null default "draft" |
| registration_start | timestamptz | not null |
| registration_close | timestamptz | not null |
| modification_deadline | timestamptz | not null |
| planned_start | timestamptz | not null |
| planned_end | timestamptz | not null |
| actual_start | timestamptz |  |
| actual_end | timestamptz |  |
| checkin_radius_m | integer | not null default 120 |
| organizer_contact | text | not null default "" |
| locality | text | not null default "" — település: a címkeresést erre szűkíti (pl. csak "Fő utca 12." esetén) |
| center_lat | double | — a település geokódolt közepe (térkép-fókusz) |
| center_lon | double |  |
| cancellation_reason | text |  |
| next_station_number | integer | not null default 1 |
| anonymized_at | timestamptz | — személyes adatok anonimizálásának időpontja (megőrzési szabály) |
| access_revoked_at | timestamptz | — résztvevői hozzáférések lezárása (lezárás után 7 nappal) |
| created_at | timestamptz | not null, default now |
| updated_at | timestamptz | not null default now |

Megkötések / indexek: `events_single_active_uq` (egyedi)

## teams

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| event_id | uuid | not null → events.id |
| name | text | not null |
| contact_name | text | not null |
| email | text | not null |
| pending_email | text |  |
| phone | text | not null |
| status | text | not null default "pending" |
| status_reason | text |  |
| idempotency_key | text |  |
| approved_at | timestamptz |  |
| created_at | timestamptz | not null, default now |
| updated_at | timestamptz | not null default now |

Megkötések / indexek: `teams_event_name_uq` (egyedi), `teams_idem_uq` (egyedi)

## team_members

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| team_id | uuid | not null → teams.id |
| name | text | not null |
| category | text | not null — child | adult |

## hosts

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| event_id | uuid | not null → events.id |
| contact_name | text | not null |
| email | text | not null |
| phone | text | not null |
| address | text | not null |
| normalized_address | text | not null |
| latitude | double |  |
| longitude | double |  |
| location_confirmed | boolean | not null default false |
| place_id | text | — Google place ID (a Google feltételei szerint ez tárolható) |
| pickup_mode | text | not null — gift_outside | ring_bell |
| participant_note | text |  |
| status | text | not null default "pending" |
| status_reason | text |  |
| idempotency_key | text |  |
| approved_at | timestamptz |  |
| created_at | timestamptz | not null, default now |
| updated_at | timestamptz | not null default now |

Megkötések / indexek: `hosts_event_address_uq` (egyedi), `hosts_idem_uq` (egyedi)

## stations

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| event_id | uuid | not null → events.id |
| number | integer | not null — nem változik, nem használódik újra |
| host_id | uuid | → hosts.id — null = virtuális állomás |
| address | text | not null |
| latitude | double | not null |
| longitude | double | not null |
| pickup_mode | text | not null |
| participant_note | text |  |
| status | text | not null default "active" — active | removed |
| removed_reason | text |  |
| removed_at | timestamptz |  |
| created_at | timestamptz | not null, default now |

Megkötések / indexek: `stations_event_number_uq` (egyedi), `stations_host_uq` (egyedi)

## access_credentials

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| subject_type | text | not null — team | host |
| subject_id | uuid | not null |
| event_id | uuid | not null → events.id |
| token_hash | text | not null unique — SHA-256(link token) |
| pin_hash | text | not null — argon2id |
| failed_attempts | integer | not null default 0 |
| locked_until | timestamptz |  |
| revoked_at | timestamptz |  |
| created_at | timestamptz | not null, default now |

Megkötések / indexek: `access_subject_uq` (egyedi)

## access_sessions

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| credential_id | uuid | not null → accessCredentials.id |
| token_hash | text | not null unique |
| csrf_token | text | not null |
| user_agent | text |  |
| created_at | timestamptz | not null, default now |
| last_seen_at | timestamptz | not null default now |

## audit_logs

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| at | timestamptz | not null default now |
| actor_type | text | not null — admin | team | host | system |
| actor_id | uuid |  |
| action | text | not null |
| entity_type | text |  |
| entity_id | uuid |  |
| event_id | uuid |  |
| before | jsonb |  |
| after | jsonb |  |
| reason | text |  |
| correlation_id | text |  |

Megkötések / indexek: `audit_at_idx` (index), `audit_entity_idx` (index), `audit_actor_idx` (index)

## rate_limit_hits

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| bucket | text | not null |
| key | text | not null |
| at | timestamptz | not null default now |

Megkötések / indexek: `rate_bucket_idx` (index)

## email_deliveries

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| type | text | not null |
| recipient | text | not null |
| subject | text | not null |
| body_enc | text |  |
| sensitive | boolean | not null default false |
| dedup_key | text | unique |
| event_id | uuid |  |
| entity_type | text |  |
| entity_id | uuid |  |
| status | text | not null default "pending" — pending | sent | failed |
| attempts | integer | not null default 0 |
| resend_count | integer | not null default 0 |
| last_attempt_at | timestamptz |  |
| next_attempt_at | timestamptz | not null default now |
| last_error | text |  |
| last_resend_at | timestamptz |  |
| sent_at | timestamptz |  |
| created_at | timestamptz | not null, default now |

Megkötések / indexek: `email_due_idx` (index)

## participant_tokens

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| purpose | text | not null — pin_recovery | email_change |
| subject_type | text | not null |
| subject_id | uuid | not null |
| token_hash | text | not null unique |
| new_email | text |  |
| expires_at | timestamptz | not null |
| used_at | timestamptz |  |
| created_at | timestamptz | not null, default now |

## policy_consents

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| subject_type | text | not null |
| subject_id | uuid | not null |
| event_id | uuid | not null |
| kind | text | not null — privacy | rules |
| version | text | not null |
| at | timestamptz | not null default now |

## check_ins

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| event_id | uuid | not null → events.id |
| team_id | uuid | not null → teams.id |
| station_id | uuid | not null → stations.id |
| status | text | not null default "accepted" — accepted | needs_review | rejected |
| source | text | not null default "online" — online | offline | admin |
| original_at | timestamptz | not null — a csapat szerinti (offline: eredeti helyi) idő |
| received_at | timestamptz | not null default now — szerver fogadási idő |
| distance_m | double |  |
| accuracy_m | double |  |
| admin_recorded | boolean | not null default false |
| reason | text |  |
| review_reason | text | — needs_review oka: station_removed | after_event_end | before_event_start | clock_anomaly | distance_mismatch | inaccurate |
| reviewed_by | uuid |  |
| reviewed_at | timestamptz |  |
| client_id | text | — offline queue elem azonosítója (idempotencia) |

Megkötések / indexek: `checkins_team_station_uq` (egyedi), `checkins_client_uq` (egyedi), `checkins_event_idx` (index)

## gift_cycles

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| station_id | uuid | not null → stations.id |
| seq | integer | not null |
| status | text | not null default "has_gifts" — has_gifts | depleted |
| note | text | — a host megjegyzése az elfogyott állapothoz (a csapatok látják) |
| warning_sent_at | timestamptz |  |
| started_at | timestamptz | not null default now |
| depleted_at | timestamptz |  |

Megkötések / indexek: `gift_cycles_station_seq_uq` (egyedi)

## gift_reports

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| cycle_id | uuid | not null → giftCycles.id |
| team_id | uuid | not null → teams.id |
| at | timestamptz | not null default now |

Megkötések / indexek: `gift_reports_cycle_team_uq` (egyedi)

## photos

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| event_id | uuid | not null → events.id |
| team_id | uuid | not null → teams.id |
| station_id | uuid | not null → stations.id |
| status | text | not null default "visible" — visible | hidden_reported | pending_review | rejected | deleted |
| file_key | text | — PHOTO_DIR-hez viszonyított útvonal; törlés után null |
| thumb_key | text |  |
| width | integer |  |
| height | integer |  |
| bytes | integer |  |
| client_id | text | — offline queue idempotencia |
| review_reason | text | — miért került admin review-ra (offline szinkron) |
| original_at | timestamptz | not null |
| received_at | timestamptz | not null default now |
| deleted_at | timestamptz |  |
| deleted_by | text | — team | admin |

Megkötések / indexek: `photos_station_idx` (index), `photos_team_station_idx` (index), `photos_client_uq` (egyedi)

## photo_reports

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| photo_id | uuid | not null → photos.id |
| reporter_type | text | not null — team | host |
| reporter_id | uuid | not null |
| reason | text | not null — child_privacy | offensive | accidental | other |
| text | text |  |
| at | timestamptz | not null default now |
| decision | text | — restored | deleted |
| decided_by | uuid |  |
| decided_at | timestamptz |  |

Megkötések / indexek: `photo_reports_uq` (egyedi)

## geocode_cache

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| query_norm | text | PK |
| result | jsonb | not null — { lat, lon, label, provider } vagy { none: true } |
| created_at | timestamptz | not null, default now |

## settings

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| key | text | PK |
| value | jsonb | not null |
| updated_at | timestamptz | not null default now |

## error_events

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| at | timestamptz | not null default now |
| correlation_id | text |  |
| route | text |  |
| message | text | not null |

Megkötések / indexek: `error_events_at_idx` (index)

## backup_runs

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| kind | text | not null — daily | manual | event_snapshot |
| status | text | not null default "running" — running | ok | failed |
| event_id | uuid |  |
| db_file | text |  |
| photos_file | text |  |
| bytes | integer |  |
| error | text |  |
| started_at | timestamptz | not null default now |
| finished_at | timestamptz |  |

Megkötések / indexek: `backup_runs_idx` (index)

## data_requests

| Oszlop | Típus | Megjegyzés |
|---|---|---|
| id | uuid PK | |
| kind | text | not null — access | rectification | erasure | anonymization |
| summary | text | not null — rövid leírás, személyes adat nélkül |
| status | text | not null default "open" — open | done | rejected |
| note | text |  |
| created_by | uuid | not null |
| created_at | timestamptz | not null, default now |
| resolved_by | uuid |  |
| resolved_at | timestamptz |  |

## Üzleti megkötések, amelyeket az adatbázis kényszerít

- Egyszerre legfeljebb egy `active` esemény (`events_single_active_uq`, részleges egyedi index).
- Csapatnév egyedi eseményen belül, kis/nagybetűtől függetlenül (`teams_event_name_uq`).
- Cím egyedi eseményen belül a függő/jóváhagyott host jelentkezéseknél (`hosts_event_address_uq`).
- Csapatonként legalább egy gyermek tag: halasztott constraint trigger (`teams_child_ck`, `team_members_child_ck`).
- Egy csapat egy állomásra egyszer check-inelhet (`checkins_team_station_uq`); az offline queue-elem azonosítója is egyedi csapatonként.
- Állomásszám változatlan és nem használódik újra: számláló az eseményen (`events.next_station_number`) + egyedi (`stations_event_number_uq`).
- Egy csapat ajándék-ciklusonként egyszer jelezhet (`gift_reports_cycle_team_uq`); egy host egy állomást hozhat létre (`stations_host_uq`).
- Az `audit_logs` tábla csak hozzáfűzhető: UPDATE/DELETE trigger tiltja.
- Az e-mail deduplikációs kulcs egyedi (`email_deliveries.dedup_key`); admin e-mail-cím kis/nagybetűtől függetlenül egyedi.
- Jelentkezés idempotencia-kulcs egyedi eseményenként (`teams_idem_uq`, `hosts_idem_uq`).
