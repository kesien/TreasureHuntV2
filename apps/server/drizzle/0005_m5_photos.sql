CREATE TABLE "photo_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"reporter_type" text NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"text" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "photo_reports_reason_ck" CHECK ("photo_reports"."reason" in ('child_privacy','offensive','accidental','other'))
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"status" text DEFAULT 'visible' NOT NULL,
	"file_key" text,
	"thumb_key" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"client_id" text,
	"original_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "photos_status_ck" CHECK ("photos"."status" in ('visible','hidden_reported','deleted'))
);
--> statement-breakpoint
ALTER TABLE "photo_reports" ADD CONSTRAINT "photo_reports_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photo_reports_uq" ON "photo_reports" USING btree ("photo_id","reporter_type","reporter_id");--> statement-breakpoint
CREATE INDEX "photos_station_idx" ON "photos" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "photos_team_station_idx" ON "photos" USING btree ("team_id","station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_client_uq" ON "photos" USING btree ("team_id","client_id") WHERE "photos"."client_id" is not null;