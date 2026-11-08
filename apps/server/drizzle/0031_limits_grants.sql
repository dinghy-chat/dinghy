-- A suspended workspace has no widget either, so it gets the same answer as an unknown key.
CREATE OR REPLACE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    LEFT JOIN subscription AS s ON s.workspace_id = w.id
    WHERE w.public_key = key AND w.active AND w.deleted_at IS NULL AND s.read_only_at IS NULL
      AND w.suspended_at IS NULL
  $$;
--> statement-breakpoint
-- The return type changes again: the app also needs to know which workspaces are suspended. The
-- reason stays out, because it is for the server's admin.
DROP FUNCTION operator_workspaces(uuid);
--> statement-breakpoint
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role, active boolean, read_only boolean, waiting boolean, suspended boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role, w.active, s.read_only_at IS NOT NULL, w.waiting_since IS NOT NULL,
      w.suspended_at IS NOT NULL
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
-- The cloud's worker deletes images after 12 months. This finds the workspaces that have one older
-- than `cutoff`, and the worker then works in each workspace's own context, through the policies.
CREATE FUNCTION workspaces_with_old_images(cutoff timestamptz, max_rows integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT a.workspace_id
    FROM attachment AS a
    WHERE a.created_at < cutoff
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspaces_with_old_images(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspaces_with_old_images(timestamptz, integer) TO dinghy_worker;
--> statement-breakpoint
-- In a workspace's own context only: it removes the attachment row, marks its message, and queues
-- the stored file for the deletions the worker already runs.
GRANT UPDATE (metadata) ON message TO dinghy_worker;
--> statement-breakpoint
-- The column grant lets the worker claim rows with FOR UPDATE SKIP LOCKED, which needs one. It never
-- changes a creation time.
GRANT DELETE, UPDATE (created_at) ON attachment TO dinghy_worker;
--> statement-breakpoint
GRANT INSERT ON storage_deletion TO dinghy_worker;
