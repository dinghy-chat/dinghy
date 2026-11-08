-- With a mail server, an account must now verify its email before it signs in. Accounts from before
-- that keep signing in as they did: they count as verified.
UPDATE "operator" SET "email_verified" = true WHERE "email_verified" = false;
