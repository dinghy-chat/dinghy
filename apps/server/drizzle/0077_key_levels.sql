ALTER TABLE "api_key" ADD COLUMN "level" text DEFAULT 'conversations' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook" ADD COLUMN "created_by_operator_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_created_by_operator_fk" FOREIGN KEY ("workspace_id","created_by_operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_created_by_api_key_fk" FOREIGN KEY ("workspace_id","created_by_api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_level" CHECK ("api_key"."level" in ('conversations', 'setup'));--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_one_creator" CHECK (num_nonnulls("webhook"."created_by_operator_id", "webhook"."created_by_api_key_id") <= 1);