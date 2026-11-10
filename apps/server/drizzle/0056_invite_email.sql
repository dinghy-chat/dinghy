-- An invite now goes to one email address. An older invite has none, so it is revoked, and the
-- empty email matches no operator. Used invites keep their history.
ALTER TABLE "invite" ADD COLUMN "email" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "invite" ALTER COLUMN "email" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "mailed" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "invite" ALTER COLUMN "mailed" DROP DEFAULT;--> statement-breakpoint
UPDATE "invite" SET "revoked_at" = now() WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
