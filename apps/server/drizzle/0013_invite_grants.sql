ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invite TO dinghy_app
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invite TO dinghy_app;
