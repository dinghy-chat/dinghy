-- For the search index on (workspace_id, body): btree_gin lets one GIN index hold the workspace and
-- the message's trigrams, so a search reads only its own workspace's entries. Like pg_trgm, it is a
-- trusted extension, so the role that owns the database creates it, with no superuser.
CREATE EXTENSION IF NOT EXISTS btree_gin;
