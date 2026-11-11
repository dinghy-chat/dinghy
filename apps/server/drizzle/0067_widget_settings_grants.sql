ALTER TABLE widget_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON widget_settings TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app makes the row with its workspace, and an owner or an admin changes it. The purge needs no
-- grant: the row goes with its workspace row, by the foreign key's cascade.
GRANT SELECT, INSERT, UPDATE ON widget_settings TO dinghy_app;
--> statement-breakpoint
-- Global, as the operator is. The app uploads, replaces, removes and serves a picture, and an
-- account's delete removes it.
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_picture TO dinghy_app;
--> statement-breakpoint
-- The widget's words and logo moved to widget_settings, which the widget reads in its own context.
-- A new return type needs DROP and CREATE, so the grant is made again.
DROP FUNCTION widget_workspace(text);
--> statement-breakpoint
CREATE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    WHERE w.public_key = key AND workspace_access(w.id) = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION widget_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION widget_workspace(text) TO dinghy_app;
