ALTER TYPE "public"."alert_channel" ADD VALUE 'transcript';--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "transcript" boolean DEFAULT true NOT NULL;