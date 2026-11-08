ALTER TABLE "visitor" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "claims" jsonb;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "public_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "signing_secret" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_token_hash_key" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_public_key_unique" UNIQUE("public_key");--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_one_identity" CHECK (num_nonnulls("visitor"."external_id", "visitor"."token_hash") = 1);