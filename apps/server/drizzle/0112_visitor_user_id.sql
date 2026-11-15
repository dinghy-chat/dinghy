ALTER TABLE "visitor" RENAME COLUMN "external_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "visitor" RENAME CONSTRAINT "visitor_external_id_key" TO "visitor_user_id_key";
