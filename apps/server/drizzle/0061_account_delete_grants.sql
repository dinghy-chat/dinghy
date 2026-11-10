-- A self-hosted server keeps at least one workspace, so its owner's delete asks whether another
-- workspace that is not deleted exists. That reads across workspaces, which the tenant policy hides.
CREATE FUNCTION other_workspace_exists(target uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM workspace WHERE id <> target AND deleted_at IS NULL)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION other_workspace_exists(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION other_workspace_exists(uuid) TO dinghy_app;
