ALTER TABLE "alert_delivery" ADD COLUMN "covered_from_seq" bigint;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "covered_to_seq" bigint;--> statement-breakpoint
CREATE INDEX "message_changed_idx" ON "message" USING btree ("workspace_id","changed_seq") WHERE "message"."changed_seq" is not null;--> statement-breakpoint
-- Emails sent before this release recorded no range. A reply email carried at least the reply that
-- queued it, and a transcript every message up to the event that queued it, so these ranges never
-- show a reply as unsent, or let one change, that the visitor already got.
UPDATE "alert_delivery" SET "covered_from_seq" = "event_seq", "covered_to_seq" = "event_seq"
WHERE "channel" = 'email' AND "visitor_id" IS NOT NULL AND "outcome" = 'sent';--> statement-breakpoint
-- As text, because an upgrade from before 0078 adds 'transcript' in this same transaction, and
-- Postgres refuses a new enum value there.
UPDATE "alert_delivery" SET "covered_from_seq" = 0, "covered_to_seq" = "event_seq"
WHERE "channel"::text = 'transcript' AND "outcome" = 'sent';
