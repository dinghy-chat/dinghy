ALTER TABLE chat_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON chat_link TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app reads a link when a visitor opens it. The worker makes one for each reply email.
GRANT SELECT ON chat_link TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON chat_link TO dinghy_worker;
--> statement-breakpoint
-- The worker prunes expired links across workspaces, which needs it to find them first.
CREATE POLICY worker_find_chat_links ON chat_link FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_chat_links ON chat_link FOR DELETE TO dinghy_worker USING (true);
