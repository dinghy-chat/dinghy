ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_hours TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- An owner or an admin saves them, and the widget's appearance reads them. The purge needs no grant:
-- the row goes with its workspace row, by the foreign key's cascade.
GRANT SELECT, INSERT, UPDATE ON business_hours TO dinghy_app;
