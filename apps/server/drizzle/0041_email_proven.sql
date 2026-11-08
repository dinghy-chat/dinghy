ALTER TABLE "operator" ALTER COLUMN "email_verified" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "operator" ADD COLUMN "email_proven" boolean DEFAULT true NOT NULL;