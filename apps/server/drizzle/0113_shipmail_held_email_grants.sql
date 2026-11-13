ALTER TABLE shipmail_held_email ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON shipmail_held_email TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The webhook notes an email it keeps for a closed workspace. The purge needs no grant: a row goes
-- with its workspace.
GRANT INSERT ON shipmail_held_email TO dinghy_app;
--> statement-breakpoint
-- The worker claims kept emails across workspaces, and deletes each row once its email is in,
-- refused for good, gone or 90 days old.
GRANT SELECT, UPDATE (next_try_at), DELETE ON shipmail_held_email TO dinghy_worker;
--> statement-breakpoint
CREATE POLICY worker_find_held_emails ON shipmail_held_email FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_claim_held_emails ON shipmail_held_email FOR UPDATE TO dinghy_worker
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_delete_held_emails ON shipmail_held_email FOR DELETE TO dinghy_worker
  USING (true);
--> statement-breakpoint
-- The worker claims only the emails of workspaces that take them again.
GRANT EXECUTE ON FUNCTION workspace_access(uuid) TO dinghy_worker;
