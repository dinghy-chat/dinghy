ALTER TABLE conversation_read ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_read TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The inbox reads each operator's position and an opened conversation moves it. The rows go with
-- their conversation or member, by the foreign keys' cascade, so nothing deletes them directly.
GRANT SELECT, INSERT, UPDATE ON conversation_read TO dinghy_app;
