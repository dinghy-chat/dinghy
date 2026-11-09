DROP INDEX "message_body_trgm_idx";--> statement-breakpoint
CREATE INDEX "message_workspace_body_trgm_idx" ON "message" USING gin ("workspace_id","body" gin_trgm_ops);