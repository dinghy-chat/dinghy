-- The return type changes again: the app also needs to know which workspaces wait for the cloud.
DROP FUNCTION operator_workspaces(uuid);
--> statement-breakpoint
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role, active boolean, read_only boolean, waiting boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role, w.active, s.read_only_at IS NOT NULL, w.waiting_since IS NOT NULL
    FROM workspace_member AS m
    JOIN workspace AS w ON w.id = m.workspace_id
    LEFT JOIN subscription AS s ON s.workspace_id = w.id
    WHERE m.operator_id = target_operator AND m.removed_at IS NULL AND w.deleted_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_workspaces(uuid) TO dinghy_app;
--> statement-breakpoint
-- A payment the worker finds in Stripe activates the workspace, and ends its wait for the cloud.
GRANT UPDATE (waiting_since) ON workspace TO dinghy_worker;
