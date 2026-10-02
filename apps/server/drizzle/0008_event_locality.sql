ALTER TABLE "events" ADD COLUMN "locality" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "center_lat" double precision;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "center_lon" double precision;