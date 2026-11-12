ALTER TABLE "widget_settings" ADD COLUMN "customized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "widget_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD COLUMN "get_started_dismissed_at" timestamp with time zone;