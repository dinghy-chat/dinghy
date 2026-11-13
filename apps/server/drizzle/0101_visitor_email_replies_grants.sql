ALTER TABLE reply_address ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON reply_address TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app reads an address when a reply to it arrives, and notes its use. The worker makes one for
-- each email to a visitor. The purge needs no grant: an address goes with its conversation.
GRANT SELECT, UPDATE ON reply_address TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON reply_address TO dinghy_worker;
--> statement-breakpoint
-- The worker prunes unused addresses across workspaces, which needs it to find them first.
CREATE POLICY worker_find_reply_addresses ON reply_address FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_reply_addresses ON reply_address FOR DELETE TO dinghy_worker USING (true);
