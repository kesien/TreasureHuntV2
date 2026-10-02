import { sql } from "drizzle-orm";
import {
  boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ---------- Admin ----------
export const admins = pgTable("admins", {
  id: id(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  totpSecretEnc: text("totp_secret_enc"), // APP_SECRET-tel titkosítva
  totpConfirmed: boolean("totp_confirmed").notNull().default(false),
  status: text("status").notNull().default("invited"), // invited | active | archived
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: ts("locked_until"),
  createdAt: createdAt(),
  archivedAt: ts("archived_at"),
}, (t) => [
  uniqueIndex("admins_email_uq").on(sql`lower(${t.email})`),
  check("admins_status_ck", sql`${t.status} in ('invited','active','archived')`),
]);

// Meghívó és jelszó-visszaállító linkek (egyszer használatos, hash-elve)
export const adminTokens = pgTable("admin_tokens", {
  id: id(),
  adminId: uuid("admin_id").notNull().references(() => admins.id),
  kind: text("kind").notNull(), // invitation | password_reset
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const adminRecoveryCodes = pgTable("admin_recovery_codes", {
  id: id(),
  adminId: uuid("admin_id").notNull().references(() => admins.id),
  codeHash: text("code_hash").notNull(),
  usedAt: ts("used_at"),
});

export const adminSessions = pgTable("admin_sessions", {
  id: id(),
  adminId: uuid("admin_id").notNull().references(() => admins.id),
  tokenHash: text("token_hash").notNull().unique(),
  csrfToken: text("csrf_token").notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

// ---------- Event ----------
export const events = pgTable("events", {
  id: id(),
  name: text("name").notNull(),
  type: text("type").notNull(), // halloween | easter
  shortDescription: text("short_description").notNull().default(""),
  rules: text("rules").notNull().default(""),
  status: text("status").notNull().default("draft"),
  registrationStart: ts("registration_start").notNull(),
  registrationClose: ts("registration_close").notNull(),
  modificationDeadline: ts("modification_deadline").notNull(),
  plannedStart: ts("planned_start").notNull(),
  plannedEnd: ts("planned_end").notNull(),
  actualStart: ts("actual_start"),
  actualEnd: ts("actual_end"),
  checkinRadiusM: integer("checkin_radius_m").notNull().default(120),
  organizerContact: text("organizer_contact").notNull().default(""),
  cancellationReason: text("cancellation_reason"),
  nextStationNumber: integer("next_station_number").notNull().default(1),
  anonymizedAt: ts("anonymized_at"), // személyes adatok anonimizálásának időpontja (megőrzési szabály)
  accessRevokedAt: ts("access_revoked_at"), // résztvevői hozzáférések lezárása (lezárás után 7 nappal)
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  // Egyszerre pontosan egy Active esemény lehet (spec §22, §82)
  uniqueIndex("events_single_active_uq").on(t.status).where(sql`${t.status} = 'active'`),
  check("events_status_ck", sql`${t.status} in ('draft','registration_open','preparation','active','closed','cancelled')`),
  check("events_radius_ck", sql`${t.checkinRadiusM} between 10 and 1000`),
]);

// ---------- Team ----------
export const teams = pgTable("teams", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  name: text("name").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  pendingEmail: text("pending_email"),
  phone: text("phone").notNull(),
  status: text("status").notNull().default("pending"),
  statusReason: text("status_reason"),
  idempotencyKey: text("idempotency_key"),
  approvedAt: ts("approved_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("teams_event_name_uq").on(t.eventId, sql`lower(${t.name})`),
  uniqueIndex("teams_idem_uq").on(t.eventId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  check("teams_status_ck", sql`${t.status} in ('pending','approved','rejected','withdrawn','removed','expired','archived')`),
]);

export const teamMembers = pgTable("team_members", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull(), // child | adult
}, (t) => [check("members_category_ck", sql`${t.category} in ('child','adult')`)]);

// ---------- Host + Station ----------
export const hosts = pgTable("hosts", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  normalizedAddress: text("normalized_address").notNull(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  locationConfirmed: boolean("location_confirmed").notNull().default(false),
  pickupMode: text("pickup_mode").notNull(), // gift_outside | ring_bell
  participantNote: text("participant_note"),
  status: text("status").notNull().default("pending"),
  statusReason: text("status_reason"),
  idempotencyKey: text("idempotency_key"),
  approvedAt: ts("approved_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  // Egy cím egyszer lehet állomás az eseményen (aktív jelentkezéseknél)
  uniqueIndex("hosts_event_address_uq").on(t.eventId, t.normalizedAddress)
    .where(sql`${t.status} in ('pending','approved')`),
  uniqueIndex("hosts_idem_uq").on(t.eventId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  check("hosts_status_ck", sql`${t.status} in ('pending','approved','rejected','withdrawn','removed','expired','archived')`),
  check("hosts_pickup_ck", sql`${t.pickupMode} in ('gift_outside','ring_bell')`),
]);

export const stations = pgTable("stations", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  number: integer("number").notNull(), // nem változik, nem használódik újra
  hostId: uuid("host_id").references(() => hosts.id), // null = virtuális állomás
  address: text("address").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  pickupMode: text("pickup_mode").notNull(),
  participantNote: text("participant_note"),
  status: text("status").notNull().default("active"), // active | removed
  removedReason: text("removed_reason"),
  removedAt: ts("removed_at"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("stations_event_number_uq").on(t.eventId, t.number),
  uniqueIndex("stations_host_uq").on(t.hostId).where(sql`${t.hostId} is not null`),
  check("stations_status_ck", sql`${t.status} in ('active','removed')`),
]);

// ---------- Team/Host hozzáférés ----------
export const accessCredentials = pgTable("access_credentials", {
  id: id(),
  subjectType: text("subject_type").notNull(), // team | host
  subjectId: uuid("subject_id").notNull(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256(link token)
  pinHash: text("pin_hash").notNull(), // argon2id
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: ts("locked_until"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("access_subject_uq").on(t.subjectType, t.subjectId),
  check("access_subject_ck", sql`${t.subjectType} in ('team','host')`),
]);

export const accessSessions = pgTable("access_sessions", {
  id: id(),
  credentialId: uuid("credential_id").notNull().references(() => accessCredentials.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  csrfToken: text("csrf_token").notNull(),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
});

// ---------- Audit (append-only) ----------
export const auditLogs = pgTable("audit_logs", {
  id: id(),
  at: ts("at").notNull().defaultNow(),
  actorType: text("actor_type").notNull(), // admin | team | host | system
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  eventId: uuid("event_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  correlationId: text("correlation_id"),
}, (t) => [
  index("audit_at_idx").on(t.at),
  index("audit_entity_idx").on(t.entityType, t.entityId),
  index("audit_actor_idx").on(t.actorId),
]);

// Rate limit / sikertelen próbák számláló (IP + kulcs szerint)
export const rateLimitHits = pgTable("rate_limit_hits", {
  id: id(),
  bucket: text("bucket").notNull(),
  key: text("key").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("rate_bucket_idx").on(t.bucket, t.key, t.at)]);

// ---------- E-mail outbox ----------
export const emailDeliveries = pgTable("email_deliveries", {
  id: id(),
  type: text("type").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  // A törzs APP_SECRET-tel titkosítva; érzékeny típusoknál (PIN/link) sikeres küldés után törlődik.
  bodyEnc: text("body_enc"),
  sensitive: boolean("sensitive").notNull().default(false),
  dedupKey: text("dedup_key").unique(),
  eventId: uuid("event_id"),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  status: text("status").notNull().default("pending"), // pending | sent | failed
  attempts: integer("attempts").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  lastAttemptAt: ts("last_attempt_at"),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  lastResendAt: ts("last_resend_at"),
  sentAt: ts("sent_at"),
  createdAt: createdAt(),
}, (t) => [
  index("email_due_idx").on(t.status, t.nextAttemptAt),
  check("email_status_ck", sql`${t.status} in ('pending','sent','failed')`),
]);

// ---------- Egyszer használatos résztvevői tokenek (PIN-helyreállítás, e-mail megerősítés) ----------
export const participantTokens = pgTable("participant_tokens", {
  id: id(),
  purpose: text("purpose").notNull(), // pin_recovery | email_change
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  newEmail: text("new_email"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

// ---------- Hozzájárulás ----------
export const policyConsents = pgTable("policy_consents", {
  id: id(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  eventId: uuid("event_id").notNull(),
  kind: text("kind").notNull(), // privacy | rules
  version: text("version").notNull(),
  at: ts("at").notNull().defaultNow(),
});

// ---------- Check-in (pontos GPS koordináta sosem tárolódik) ----------
export const checkIns = pgTable("check_ins", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  stationId: uuid("station_id").notNull().references(() => stations.id),
  status: text("status").notNull().default("accepted"), // accepted | needs_review | rejected
  source: text("source").notNull().default("online"), // online | offline | admin
  originalAt: ts("original_at").notNull(), // a csapat szerinti (offline: eredeti helyi) idő
  receivedAt: ts("received_at").notNull().defaultNow(), // szerver fogadási idő
  distanceM: doublePrecision("distance_m"),
  accuracyM: doublePrecision("accuracy_m"),
  adminRecorded: boolean("admin_recorded").notNull().default(false),
  reason: text("reason"),
  reviewReason: text("review_reason"), // needs_review oka: station_removed | after_event_end | before_event_start | clock_anomaly | distance_mismatch | inaccurate
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  clientId: text("client_id"), // offline queue elem azonosítója (idempotencia)
}, (t) => [
  uniqueIndex("checkins_team_station_uq").on(t.teamId, t.stationId),
  uniqueIndex("checkins_client_uq").on(t.teamId, t.clientId).where(sql`${t.clientId} is not null`),
  index("checkins_event_idx").on(t.eventId),
  check("checkins_status_ck", sql`${t.status} in ('accepted','needs_review','rejected')`),
]);

// ---------- Ajándék ciklusok ----------
export const giftCycles = pgTable("gift_cycles", {
  id: id(),
  stationId: uuid("station_id").notNull().references(() => stations.id),
  seq: integer("seq").notNull(),
  status: text("status").notNull().default("has_gifts"), // has_gifts | depleted
  note: text("note"), // a host megjegyzése az elfogyott állapothoz (a csapatok látják)
  warningSentAt: ts("warning_sent_at"),
  startedAt: ts("started_at").notNull().defaultNow(),
  depletedAt: ts("depleted_at"),
}, (t) => [
  uniqueIndex("gift_cycles_station_seq_uq").on(t.stationId, t.seq),
  check("gift_cycles_status_ck", sql`${t.status} in ('has_gifts','depleted')`),
]);

export const giftReports = pgTable("gift_reports", {
  id: id(),
  cycleId: uuid("cycle_id").notNull().references(() => giftCycles.id),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [uniqueIndex("gift_reports_cycle_team_uq").on(t.cycleId, t.teamId)]);

// ---------- Fotók ----------
export const photos = pgTable("photos", {
  id: id(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  stationId: uuid("station_id").notNull().references(() => stations.id),
  status: text("status").notNull().default("visible"), // visible | hidden_reported | pending_review | rejected | deleted
  fileKey: text("file_key"), // PHOTO_DIR-hez viszonyított útvonal; törlés után null
  thumbKey: text("thumb_key"),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  clientId: text("client_id"), // offline queue idempotencia
  reviewReason: text("review_reason"), // miért került admin review-ra (offline szinkron)
  originalAt: ts("original_at").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
  deletedBy: text("deleted_by"), // team | admin
}, (t) => [
  index("photos_station_idx").on(t.stationId, t.status),
  index("photos_team_station_idx").on(t.teamId, t.stationId),
  uniqueIndex("photos_client_uq").on(t.teamId, t.clientId).where(sql`${t.clientId} is not null`),
  check("photos_status_ck", sql`${t.status} in ('visible','hidden_reported','pending_review','rejected','deleted')`),
]);

export const photoReports = pgTable("photo_reports", {
  id: id(),
  photoId: uuid("photo_id").notNull().references(() => photos.id),
  reporterType: text("reporter_type").notNull(), // team | host
  reporterId: uuid("reporter_id").notNull(),
  reason: text("reason").notNull(), // child_privacy | offensive | accidental | other
  text: text("text"),
  at: ts("at").notNull().defaultNow(),
  decision: text("decision"), // restored | deleted
  decidedBy: uuid("decided_by"),
  decidedAt: ts("decided_at"),
}, (t) => [
  uniqueIndex("photo_reports_uq").on(t.photoId, t.reporterType, t.reporterId),
  check("photo_reports_reason_ck", sql`${t.reason} in ('child_privacy','offensive','accidental','other')`),
]);

// ---------- Geokódolás cache ----------
export const geocodeCache = pgTable("geocode_cache", {
  queryNorm: text("query_norm").primaryKey(),
  result: jsonb("result").notNull(), // { lat, lon, label, provider } vagy { none: true }
  createdAt: createdAt(),
});

// ---------- Beállítások (pl. SMTP, titkosított jelszóval) ----------
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------- Rendszerhibák (admin számára látható, rövid, PII nélkül) ----------
export const errorEvents = pgTable("error_events", {
  id: id(),
  at: ts("at").notNull().defaultNow(),
  correlationId: text("correlation_id"),
  route: text("route"),
  message: text("message").notNull(),
}, (t) => [index("error_events_at_idx").on(t.at)]);

// ---------- Mentések ----------
export const backupRuns = pgTable("backup_runs", {
  id: id(),
  kind: text("kind").notNull(), // daily | manual | event_snapshot
  status: text("status").notNull().default("running"), // running | ok | failed
  eventId: uuid("event_id"),
  dbFile: text("db_file"),
  photosFile: text("photos_file"),
  bytes: integer("bytes"),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
}, (t) => [
  index("backup_runs_idx").on(t.kind, t.status, t.startedAt),
  check("backup_kind_ck", sql`${t.kind} in ('daily','manual','event_snapshot')`),
  check("backup_status_ck", sql`${t.status} in ('running','ok','failed')`),
]);

// ---------- Adatkezelési kérelmek (nincs önkiszolgáló portál; admin rögzíti) ----------
export const dataRequests = pgTable("data_requests", {
  id: id(),
  kind: text("kind").notNull(), // access | rectification | erasure | anonymization
  summary: text("summary").notNull(), // rövid leírás, személyes adat nélkül
  status: text("status").notNull().default("open"), // open | done | rejected
  note: text("note"),
  createdBy: uuid("created_by").notNull(),
  createdAt: createdAt(),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: ts("resolved_at"),
}, (t) => [
  check("data_requests_kind_ck", sql`${t.kind} in ('access','rectification','erasure','anonymization')`),
  check("data_requests_status_ck", sql`${t.status} in ('open','done','rejected')`),
]);
