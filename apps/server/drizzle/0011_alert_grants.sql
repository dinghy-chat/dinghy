-- The worker finds and claims work across workspaces, then sets the context from each claimed row.
-- SELECT FOR UPDATE needs an UPDATE policy, and the tenant policy matches no row without a context.
CREATE POLICY worker_claim_events ON event FOR UPDATE TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_prune_events ON event FOR DELETE TO dinghy_worker USING (true);
--> statement-breakpoint
GRANT UPDATE (needs_alert), DELETE ON event TO dinghy_worker;
--> statement-breakpoint
ALTER TABLE alert_delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the worker uses this table, so the app role has no grant and no policy.
CREATE POLICY worker_deliveries ON alert_delivery TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_delivery TO dinghy_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscription TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON push_subscription TO dinghy_worker;
--> statement-breakpoint
ALTER TABLE email_stop ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_stop TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON email_stop TO dinghy_app;
--> statement-breakpoint
GRANT SELECT ON email_stop TO dinghy_worker;
