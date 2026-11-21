ALTER TABLE draft_change_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON draft_change_request TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- An operator asks and cancels, a key's new draft fulfills it, and a draft's delete removes it.
GRANT SELECT, INSERT, UPDATE, DELETE ON draft_change_request TO dinghy_app;
--> statement-breakpoint
-- A `draft.change_requested` webhook names the request, and the worker builds that payload.
GRANT SELECT ON draft_change_request TO dinghy_worker;
