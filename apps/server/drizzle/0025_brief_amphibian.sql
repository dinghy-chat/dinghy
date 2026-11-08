ALTER TABLE "subscription" ADD COLUMN "checkout_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billing_cleared_at" timestamp with time zone;