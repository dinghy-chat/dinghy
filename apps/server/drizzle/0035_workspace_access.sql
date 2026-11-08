-- What a workspace allows, worked out in one place. The operator API, the widget lookup and a write
-- under the workspace row lock all read it, so a new state changes this function only.
--   deleted          the owner deleted it, and the worker purges it
--   waiting_payment  a cloud signup that has not paid: only its owner's Checkout works
--   suspended        the server's admin suspended it: operators can read, nobody can send
--   read_only        the subscription ended: operators can read and export
--   waiting_cloud    an early signup that waits for the cloud: the dashboard works, the widget is off
--   active           everything works
CREATE FUNCTION workspace_access(target uuid)
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN w.deleted_at IS NOT NULL THEN 'deleted'
      WHEN NOT w.active AND w.waiting_since IS NULL THEN 'waiting_payment'
      WHEN w.suspended_at IS NOT NULL THEN 'suspended'
      WHEN s.read_only_at IS NOT NULL THEN 'read_only'
      WHEN NOT w.active THEN 'waiting_cloud'
      ELSE 'active'
    END
    FROM workspace AS w
    LEFT JOIN subscription AS s ON s.workspace_id = w.id
    WHERE w.id = target
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_access(uuid) FROM PUBLIC;
--> statement-breakpoint
-- A message write reads it again under the workspace row lock.
GRANT EXECUTE ON FUNCTION workspace_access(uuid) TO dinghy_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    WHERE w.public_key = key AND workspace_access(w.id) = 'active'
  $$;
--> statement-breakpoint
-- The return type changes for the last time: one access column instead of one per state.
DROP FUNCTION operator_workspaces(uuid);
--> statement-breakpoint
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role, access text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role, workspace_access(m.workspace_id)
    FROM workspace_member AS m
    JOIN workspace AS w ON w.id = m.workspace_id
    WHERE m.operator_id = target_operator AND m.removed_at IS NULL AND w.deleted_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_workspaces(uuid) TO dinghy_app;
