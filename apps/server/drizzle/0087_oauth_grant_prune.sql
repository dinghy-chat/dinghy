-- The worker deletes an OAuth grant that nobody ever used, such as one approved and never redeemed.
-- A grant that was never used authored nothing, so no message, note, draft or webhook names it.
GRANT DELETE ON api_key TO dinghy_worker;
--> statement-breakpoint
CREATE POLICY worker_find_unused_grants ON api_key FOR SELECT TO dinghy_worker
  USING (source = 'oauth' AND last_used_at IS NULL);
--> statement-breakpoint
CREATE POLICY worker_prune_unused_grants ON api_key FOR DELETE TO dinghy_worker
  USING (source = 'oauth' AND last_used_at IS NULL);
