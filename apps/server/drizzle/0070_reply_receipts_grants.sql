-- The operator app shows whether a reply went out by email, so the app role reads the outcome of its
-- own workspace's deliveries: these columns only, never the claim or retry state.
CREATE POLICY tenant_read ON alert_delivery FOR SELECT TO dinghy_app
  USING (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT (workspace_id, visitor_id, channel, outcome, finished_at) ON alert_delivery TO dinghy_app;
