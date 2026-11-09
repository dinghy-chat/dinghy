ALTER TABLE page_view ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON page_view TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app records a page, trims a visitor's oldest rows and deletes them with a conversation. An
-- import writes them too.
GRANT SELECT, INSERT, UPDATE, DELETE ON page_view TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON page_view TO dinghy_worker;
--> statement-breakpoint
-- The worker deletes rows older than 90 days across workspaces, which needs it to find them first.
CREATE POLICY worker_find_page_views ON page_view FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_page_views ON page_view FOR DELETE TO dinghy_worker USING (true);
