-- Operators sign in with a link sent to their email, so nothing reads a password any more. Their
-- hashes go, and each operator keeps their account and signs in by link to the same email.
DELETE FROM "account" WHERE "provider_id" = 'credential';
