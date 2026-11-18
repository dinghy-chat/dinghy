ALTER TABLE site_hour ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON site_hour TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app reads the hours for the Visitors page.
GRANT SELECT ON site_hour TO dinghy_app;
--> statement-breakpoint
-- The worker copies each hour from Valkey in its workspace's context, and deletes old hours.
GRANT SELECT, INSERT, UPDATE, DELETE ON site_hour TO dinghy_worker;
--> statement-breakpoint
-- The worker deletes hours older than 92 days across workspaces, which needs it to find them first.
CREATE POLICY worker_find_site_hours ON site_hour FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_site_hours ON site_hour FOR DELETE TO dinghy_worker USING (true);
