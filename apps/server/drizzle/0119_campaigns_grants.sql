ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE campaign_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign_run TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE campaign_trigger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign_trigger TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE campaign_day ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON campaign_day TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE contact_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_event TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app saves campaigns, runs their batches and counts their results, as it writes their
-- messages. The worker's due runs go through the app's role too.
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign, campaign_run, campaign_trigger, campaign_day, contact_event TO dinghy_app;
--> statement-breakpoint
-- A webhook's body names the campaign with its results. The worker finds the live schedules and
-- the unfinished runs across workspaces.
GRANT SELECT ON campaign, campaign_run, campaign_trigger, campaign_day TO dinghy_worker;
--> statement-breakpoint
CREATE POLICY worker_find_campaigns ON campaign FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_find_campaign_runs ON campaign_run FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_find_campaign_triggers ON campaign_trigger FOR SELECT TO dinghy_worker
  USING (true);
