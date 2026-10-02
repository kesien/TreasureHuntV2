CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"event_id" uuid,
	"db_file" text,
	"photos_file" text,
	"bytes" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "backup_kind_ck" CHECK ("backup_runs"."kind" in ('daily','manual','event_snapshot')),
	CONSTRAINT "backup_status_ck" CHECK ("backup_runs"."status" in ('running','ok','failed'))
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "data_requests_kind_ck" CHECK ("data_requests"."kind" in ('access','rectification','erasure','anonymization')),
	CONSTRAINT "data_requests_status_ck" CHECK ("data_requests"."status" in ('open','done','rejected'))
);
--> statement-breakpoint
CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text,
	"route" text,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "access_revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "backup_runs_idx" ON "backup_runs" USING btree ("kind","status","started_at");--> statement-breakpoint
CREATE INDEX "error_events_at_idx" ON "error_events" USING btree ("at");