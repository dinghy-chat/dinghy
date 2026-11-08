-- Dinghy now proves a mailbox itself, in email_proven. An account that BetterAuth did not count as
-- verified keeps that state there, and BetterAuth's own flag becomes true for every account, so it
-- never signs anyone out on its own.
UPDATE "operator" SET "email_proven" = "email_verified";--> statement-breakpoint
UPDATE "operator" SET "email_verified" = true WHERE "email_verified" = false;
