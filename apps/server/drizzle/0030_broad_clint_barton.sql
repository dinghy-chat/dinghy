ALTER TABLE "workspace" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
CREATE INDEX "attachment_created_idx" ON "attachment" USING btree ("created_at");