CREATE TABLE "access_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"pin_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_credentials_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "access_subject_ck" CHECK ("access_credentials"."subject_type" in ('team','host'))
);
--> statement-breakpoint
CREATE TABLE "access_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_confirmed" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "admins_status_ck" CHECK ("admins"."status" in ('invited','active','archived'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"event_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"short_description" text DEFAULT '' NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"registration_start" timestamp with time zone NOT NULL,
	"registration_close" timestamp with time zone NOT NULL,
	"modification_deadline" timestamp with time zone NOT NULL,
	"planned_start" timestamp with time zone NOT NULL,
	"planned_end" timestamp with time zone NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"checkin_radius_m" integer DEFAULT 120 NOT NULL,
	"organizer_contact" text DEFAULT '' NOT NULL,
	"cancellation_reason" text,
	"next_station_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_status_ck" CHECK ("events"."status" in ('draft','registration_open','preparation','active','closed','cancelled')),
	CONSTRAINT "events_radius_ck" CHECK ("events"."checkin_radius_m" between 10 and 1000)
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"normalized_address" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"location_confirmed" boolean DEFAULT false NOT NULL,
	"pickup_mode" text NOT NULL,
	"participant_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"idempotency_key" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_status_ck" CHECK ("hosts"."status" in ('pending','approved','rejected','withdrawn','removed','expired','archived')),
	CONSTRAINT "hosts_pickup_ck" CHECK ("hosts"."pickup_mode" in ('gift_outside','ring_bell'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"host_id" uuid,
	"address" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"pickup_mode" text NOT NULL,
	"participant_note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"removed_reason" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stations_status_ck" CHECK ("stations"."status" in ('active','removed'))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	CONSTRAINT "members_category_ck" CHECK ("team_members"."category" in ('child','adult'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"pending_email" text,
	"phone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"idempotency_key" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_status_ck" CHECK ("teams"."status" in ('pending','approved','rejected','withdrawn','removed','expired','archived'))
);
--> statement-breakpoint
ALTER TABLE "access_credentials" ADD CONSTRAINT "access_credentials_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_sessions_credential_id_access_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."access_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_subject_uq" ON "access_credentials" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_email_uq" ON "admins" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_single_active_uq" ON "events" USING btree ("status") WHERE "events"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_event_address_uq" ON "hosts" USING btree ("event_id","normalized_address") WHERE "hosts"."status" in ('pending','approved');--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_idem_uq" ON "hosts" USING btree ("event_id","idempotency_key") WHERE "hosts"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "rate_bucket_idx" ON "rate_limit_hits" USING btree ("bucket","key","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stations_event_number_uq" ON "stations" USING btree ("event_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "stations_host_uq" ON "stations" USING btree ("host_id") WHERE "stations"."host_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_event_name_uq" ON "teams" USING btree ("event_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "teams_idem_uq" ON "teams" USING btree ("event_id","idempotency_key") WHERE "teams"."idempotency_key" is not null;