-- Custom SQL migration file, put your code below! --
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscription TO dinghy_app
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON subscription TO dinghy_app;
--> statement-breakpoint
ALTER TABLE stripe_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stripe_event TO dinghy_app
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON stripe_event TO dinghy_app;
--> statement-breakpoint
-- An inactive workspace has not paid, so the widget gets the same answer as for an unknown key.
CREATE OR REPLACE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    WHERE w.public_key = key AND w.active
  $$;
--> statement-breakpoint
-- The return type changes, which CREATE OR REPLACE cannot do. The app also needs to know which
-- workspaces wait for payment.
DROP FUNCTION operator_workspaces(uuid);
--> statement-breakpoint
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role, active boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role, w.active
    FROM workspace_member AS m
    JOIN workspace AS w ON w.id = m.workspace_id
    WHERE m.operator_id = target_operator AND m.removed_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_workspaces(uuid) TO dinghy_app;
