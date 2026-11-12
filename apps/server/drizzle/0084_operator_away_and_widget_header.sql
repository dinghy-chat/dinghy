CREATE TYPE "public"."widget_header_faces" AS ENUM('online', 'repliers', 'chosen', 'none');--> statement-breakpoint
CREATE TYPE "public"."widget_header_status" AS ENUM('presence', 'reply_time');--> statement-breakpoint
ALTER TABLE "operator" ADD COLUMN "away" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "header_faces" "widget_header_faces" DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "header_face_count" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "header_dot" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "header_status" "widget_header_status" DEFAULT 'presence' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "header_members" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD CONSTRAINT "widget_settings_header_face_count" CHECK ("widget_settings"."header_face_count" between 1 and 5);