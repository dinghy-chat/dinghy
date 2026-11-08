DROP INDEX "conversation_status_idx";--> statement-breakpoint
CREATE INDEX "conversation_list_idx" ON "conversation" USING btree ("workspace_id","status","updated_at","id");