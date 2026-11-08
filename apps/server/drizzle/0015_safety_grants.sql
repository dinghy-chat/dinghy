ALTER TABLE ip_block ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ip_block TO dinghy_app
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_block TO dinghy_app;
--> statement-breakpoint
-- The worker prunes expired blocks across workspaces.
CREATE POLICY worker_prune_ip_blocks ON ip_block TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON ip_block TO dinghy_worker;
--> statement-breakpoint
ALTER TABLE storage_deletion ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The app only queues a deletion. It has no reason to read or change the queue.
CREATE POLICY app_queue_deletion ON storage_deletion FOR INSERT TO dinghy_app
  WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT INSERT ON storage_deletion TO dinghy_app;
--> statement-breakpoint
CREATE POLICY worker_deletions ON storage_deletion TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON storage_deletion TO dinghy_worker;
