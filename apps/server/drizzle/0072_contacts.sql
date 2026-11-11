ALTER TABLE "visitor" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "time_zone" text;--> statement-breakpoint
CREATE INDEX "visitor_seen_idx" ON "visitor" USING btree ("workspace_id",coalesce("last_seen_at", "created_at"),"id");--> statement-breakpoint
CREATE INDEX "visitor_created_idx" ON "visitor" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_note_length" CHECK (char_length("visitor"."note") <= 5000);--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_country" CHECK ("visitor"."country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_time_zone_length" CHECK (char_length("visitor"."time_zone") <= 64);