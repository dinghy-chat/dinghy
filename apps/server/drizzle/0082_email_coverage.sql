ALTER TABLE "alert_delivery" ADD COLUMN "covered_from_seq" bigint;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "covered_to_seq" bigint;--> statement-breakpoint
CREATE INDEX "message_changed_idx" ON "message" USING btree ("workspace_id","changed_seq") WHERE "message"."changed_seq" is not null;