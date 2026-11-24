-- A person who signs in where they chatted signed out takes that visitor's alerts, so the app moves
-- them to the signed-in visitor.
GRANT UPDATE (visitor_id) ON alert_delivery TO dinghy_app;
--> statement-breakpoint
CREATE POLICY tenant_move ON alert_delivery FOR UPDATE TO dinghy_app
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
