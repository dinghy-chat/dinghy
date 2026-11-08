ALTER TABLE "operator" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
-- An account that already has a workspace got its welcome, or signed up before welcome emails
-- existed. Either way, a later workspace must not send one.
UPDATE "operator" SET "welcomed_at" = now() WHERE "id" IN (SELECT "operator_id" FROM "workspace_member");
