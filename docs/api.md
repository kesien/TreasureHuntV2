# API dokumentáció

> Automatikusan generált (`node scripts/gen-docs.mjs`) a `apps/server/src/routes` alapján. Ne szerkeszd kézzel.

## Általános szabályok

- Minden válasz JSON; a hibák alakja: `{ "error": "kod", "message": "magyar, érthető üzenet" }`. Stack trace és belső azonosító nem kerül a válaszba.
- A munkamenet HttpOnly, SameSite=Lax süti. Állapotváltoztató kérésekhez (POST/PUT/PATCH/DELETE) bejelentkezve kötelező az `X-CSRF-Token` fejléc (értéke a bejelentkezéskor / `/me` hívásnál kapott `csrfToken`).
- A jelentkezési végpontokhoz `Idempotency-Key` fejléc kell (8–100 karakter); azonos kulccsal ismételt kérés nem hoz létre új jelentkezést.
- Az idők ISO 8601 UTC formátumban utaznak; a megjelenítés Europe/Budapest.
- Valós idejű jelzés: SSE (`/api/admin/stream`, `/api/access/stream`), csak "változott" üzenet; az adatot a normál API adja.
- Rate limit: admin belépés, PIN belépés, PIN/jelszó helyreállítás, e-mail csere, geokódolás, check-in, szinkron, fotófeltöltés, fotójelentés.

## Végpontok

| Metódus | Útvonal | Jogosultság | Forrás |
|---|---|---|---|
| POST | `/api/access/change-pin` | csapat/host | access.ts |
| POST | `/api/access/checkin` | csapat/host | game.ts |
| GET | `/api/access/host` | csapat/host | applications.ts |
| PATCH | `/api/access/host` | csapat/host | applications.ts |
| GET | `/api/access/host/dashboard` | csapat/host | game.ts |
| POST | `/api/access/host/email-change` | csapat/host | applications.ts |
| POST | `/api/access/host/gift/depleted` | csapat/host | game.ts |
| POST | `/api/access/host/gift/restock` | csapat/host | game.ts |
| PUT | `/api/access/host/location` | csapat/host | stations.ts |
| POST | `/api/access/host/withdraw` | csapat/host | applications.ts |
| POST | `/api/access/login` | nyilvános (rate limit) | access.ts |
| POST | `/api/access/logout` | csapat/host | access.ts |
| GET | `/api/access/me` | csapat/host | access.ts |
| DELETE | `/api/access/photos/:id` | csapat/host | photos.ts |
| POST | `/api/access/photos/:id/report` | csapat/host | photos.ts |
| GET | `/api/access/progress` | csapat/host | game.ts |
| GET | `/api/access/stations` | csapat/host | stations.ts |
| POST | `/api/access/stations/:id/out-of-gifts` | csapat/host | game.ts |
| GET | `/api/access/stations/:id/photos` | csapat/host | photos.ts |
| POST | `/api/access/stations/:id/photos` | csapat/host | photos.ts |
| GET | `/api/access/stream` | csapat/host | game.ts |
| POST | `/api/access/sync/checkins` | csapat/host | game.ts |
| GET | `/api/access/team` | csapat/host | applications.ts |
| PATCH | `/api/access/team` | csapat/host | applications.ts |
| POST | `/api/access/team/email-change` | csapat/host | applications.ts |
| POST | `/api/access/team/withdraw` | csapat/host | applications.ts |
| POST | `/api/admin/activation/begin` | nyilvános (rate limit) | admin.ts |
| POST | `/api/admin/activation/complete` | nyilvános (rate limit) | admin.ts |
| GET | `/api/admin/admins` | admin | admin.ts |
| POST | `/api/admin/admins/:id/archive` | admin | admin.ts |
| POST | `/api/admin/admins/:id/restore` | admin | admin.ts |
| POST | `/api/admin/admins/invite` | admin | admin.ts |
| GET | `/api/admin/audit` | admin | adminOps.ts |
| GET | `/api/admin/backups` | admin | adminOps.ts |
| POST | `/api/admin/backups` | admin | adminOps.ts |
| POST | `/api/admin/checkins` | admin | game.ts |
| POST | `/api/admin/checkins/:id/review` | admin | game.ts |
| GET | `/api/admin/data-requests` | admin | adminOps.ts |
| POST | `/api/admin/data-requests` | admin | adminOps.ts |
| POST | `/api/admin/data-requests/:id/resolve` | admin | adminOps.ts |
| GET | `/api/admin/emails` | admin | applications.ts |
| POST | `/api/admin/emails/:id/resend` | admin | applications.ts |
| GET | `/api/admin/events` | admin | events.ts |
| POST | `/api/admin/events` | admin | events.ts |
| DELETE | `/api/admin/events/:id` | admin | events.ts |
| GET | `/api/admin/events/:id` | admin | events.ts |
| PATCH | `/api/admin/events/:id` | admin | events.ts |
| GET | `/api/admin/events/:id/hosts` | admin | applications.ts |
| GET | `/api/admin/events/:id/map` | admin | adminOps.ts |
| GET | `/api/admin/events/:id/photos` | admin | photos.ts |
| GET | `/api/admin/events/:id/reviews` | admin | game.ts |
| GET | `/api/admin/events/:id/stations` | admin | stations.ts |
| POST | `/api/admin/events/:id/stations` | admin | stations.ts |
| GET | `/api/admin/events/:id/stats` | admin | adminOps.ts |
| GET | `/api/admin/events/:id/teams` | admin | applications.ts |
| POST | `/api/admin/events/:id/transition` | admin | events.ts |
| PATCH | `/api/admin/hosts/:id` | admin | adminOps.ts |
| POST | `/api/admin/hosts/:id/anonymize` | admin | adminOps.ts |
| POST | `/api/admin/hosts/:id/approve` | admin | applications.ts |
| PUT | `/api/admin/hosts/:id/location` | admin | stations.ts |
| POST | `/api/admin/hosts/:id/regenerate-link` | admin | applications.ts |
| POST | `/api/admin/hosts/:id/reissue-access` | admin | applications.ts |
| POST | `/api/admin/hosts/:id/reject` | admin | applications.ts |
| POST | `/api/admin/hosts/:id/remove` | admin | adminOps.ts |
| POST | `/api/admin/login` | nyilvános (rate limit) | admin.ts |
| POST | `/api/admin/logout` | admin | admin.ts |
| GET | `/api/admin/me` | admin | admin.ts |
| POST | `/api/admin/password-reset/complete` | nyilvános (rate limit) | admin.ts |
| POST | `/api/admin/password-reset/request` | nyilvános (rate limit) | admin.ts |
| DELETE | `/api/admin/photos/:id` | admin | photos.ts |
| POST | `/api/admin/photos/:id/decision` | admin | photos.ts |
| GET | `/api/admin/settings/smtp` | admin | applications.ts |
| PUT | `/api/admin/settings/smtp` | admin | applications.ts |
| DELETE | `/api/admin/stations/:id` | admin | stations.ts |
| GET | `/api/admin/stations/:id/gifts` | admin | game.ts |
| POST | `/api/admin/stations/:id/gifts` | admin | game.ts |
| GET | `/api/admin/stream` | admin | events.ts |
| GET | `/api/admin/system-status` | admin | adminOps.ts |
| PATCH | `/api/admin/teams/:id` | admin | adminOps.ts |
| POST | `/api/admin/teams/:id/anonymize` | admin | adminOps.ts |
| POST | `/api/admin/teams/:id/approve` | admin | applications.ts |
| GET | `/api/admin/teams/:id/progress` | admin | game.ts |
| POST | `/api/admin/teams/:id/regenerate-link` | admin | applications.ts |
| POST | `/api/admin/teams/:id/reissue-access` | admin | applications.ts |
| POST | `/api/admin/teams/:id/reject` | admin | applications.ts |
| POST | `/api/admin/teams/:id/remove` | admin | adminOps.ts |
| GET | `/api/admin/view-as/host/:id` | admin | adminOps.ts |
| GET | `/api/admin/view-as/team/:id` | admin | adminOps.ts |
| POST | `/api/geocode` | admin vagy résztvevő | stations.ts |
| GET | `/api/photos/:id/:variant` | admin / jogosult résztvevő | photos.ts |
| POST | `/api/public/email-change/confirm` | nyilvános | applications.ts |
| GET | `/api/public/events` | nyilvános | applications.ts |
| GET | `/api/public/events/:id` | nyilvános | applications.ts |
| POST | `/api/public/events/:id/geocode` | nyilvános | stations.ts |
| POST | `/api/public/events/:id/hosts` | nyilvános | applications.ts |
| POST | `/api/public/events/:id/teams` | nyilvános | applications.ts |
| POST | `/api/public/pin-recovery/complete` | nyilvános | applications.ts |
| POST | `/api/public/pin-recovery/request` | nyilvános | applications.ts |
