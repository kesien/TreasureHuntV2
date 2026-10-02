CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"source" text DEFAULT 'online' NOT NULL,
	"original_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"distance_m" double precision,
	"accuracy_m" double precision,
	"admin_recorded" boolean DEFAULT false NOT NULL,
	"reason" text,
	"client_id" text,
	CONSTRAINT "checkins_status_ck" CHECK ("check_ins"."status" in ('accepted','needs_review','rejected'))
);
--> statement-breakpoint
CREATE TABLE "gift_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'has_gifts' NOT NULL,
	"note" text,
	"warning_sent_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"depleted_at" timestamp with time zone,
	CONSTRAINT "gift_cycles_status_ck" CHECK ("gift_cycles"."status" in ('has_gifts','depleted'))
);
--> statement-breakpoint
CREATE TABLE "gift_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cycles" ADD CONSTRAINT "gift_cycles_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_reports" ADD CONSTRAINT "gift_reports_cycle_id_gift_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."gift_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_reports" ADD CONSTRAINT "gift_reports_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_team_station_uq" ON "check_ins" USING btree ("team_id","station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_client_uq" ON "check_ins" USING btree ("team_id","client_id") WHERE "check_ins"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "checkins_event_idx" ON "check_ins" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cycles_station_seq_uq" ON "gift_cycles" USING btree ("station_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_reports_cycle_team_uq" ON "gift_reports" USING btree ("cycle_id","team_id");