ALTER TABLE "photos" DROP CONSTRAINT "photos_status_ck";--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_status_ck" CHECK ("photos"."status" in ('visible','hidden_reported','pending_review','rejected','deleted'));