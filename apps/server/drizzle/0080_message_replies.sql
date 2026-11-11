ALTER TABLE "message" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "changed_seq" bigint;--> statement-breakpoint
CREATE INDEX "message_reply_to_idx" ON "message" USING btree ("workspace_id","reply_to_message_id");