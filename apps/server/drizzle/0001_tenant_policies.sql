-- The context that withWorkspace sets. A pooled connection returns an empty string after its
-- first use, so NULLIF turns that into NULL, and a query with no context matches no row.
CREATE FUNCTION current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workspace TO dinghy_app, dinghy_worker
  USING (id = current_workspace_id()) WITH CHECK (id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE workspace_member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workspace_member TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE visitor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON visitor TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON message TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON attachment TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON event TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The worker finds work across workspaces here, then sets the context from each claimed row.
CREATE POLICY worker_find_events ON event FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO dinghy_app, dinghy_worker, dinghy_backup;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON workspace TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON operator, workspace_member, visitor, conversation, message, attachment TO dinghy_app;
--> statement-breakpoint
-- The feed is append-only for the app. The worker prunes it in a later stage.
GRANT SELECT, INSERT ON event TO dinghy_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dinghy_worker, dinghy_backup;
--> statement-breakpoint
-- A new table must reach the backup role without a separate grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dinghy_backup;
--> statement-breakpoint
-- A restore needs the migration history, or the migrations would run again.
GRANT USAGE ON SCHEMA drizzle TO dinghy_backup;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO dinghy_backup;
--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO dinghy_backup;
--> statement-breakpoint
-- Sign-in has no workspace yet. The function runs as its owner, which bypasses the policies,
-- so it returns only these two columns and only to the app.
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role
    FROM workspace_member AS m
    WHERE m.operator_id = target_operator AND m.removed_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_workspaces(uuid) TO dinghy_app;
