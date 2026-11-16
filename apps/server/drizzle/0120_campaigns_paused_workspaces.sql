-- The worker finds the campaign runs due across workspaces, but may not read their workspace rows.
-- This names the workspaces that paused every campaign, so their runs never fill a pass.
CREATE FUNCTION workspaces_with_paused_campaigns()
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id FROM workspace AS w WHERE w.campaigns_paused_at IS NOT NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspaces_with_paused_campaigns() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspaces_with_paused_campaigns() TO dinghy_worker;
