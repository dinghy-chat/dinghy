CREATE TYPE "public"."visitor_locale" AS ENUM('en', 'fr', 'es');--> statement-breakpoint
CREATE TYPE "public"."widget_language" AS ENUM('visitor', 'en', 'fr', 'es');--> statement-breakpoint
CREATE TABLE "business_hours" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"time_zone" text NOT NULL,
	"week" jsonb NOT NULL,
	CONSTRAINT "business_hours_time_zone_length" CHECK (char_length("business_hours"."time_zone") <= 64)
);
--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "locale" "visitor_locale";--> statement-breakpoint
-- Existing widgets keep English, so none changes language under its owner. New ones follow the
-- visitor.
ALTER TABLE "widget_settings" ADD COLUMN "language" "widget_language" DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ALTER COLUMN "language" SET DEFAULT 'visitor';--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;