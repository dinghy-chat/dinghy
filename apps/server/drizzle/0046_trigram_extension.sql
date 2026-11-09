-- For the trigram index on message text, which search uses. pg_trgm is a trusted extension, so the
-- role that owns the database creates it, with no superuser. Every Postgres image Dinghy uses has it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
