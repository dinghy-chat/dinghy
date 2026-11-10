ALTER TABLE workspace_logo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workspace_logo TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app uploads, replaces, removes and serves a logo, and an import writes one. The purge needs
-- no grant: the logo goes with its workspace row, by the foreign key's cascade.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_logo TO dinghy_app;
--> statement-breakpoint
-- The widget lookup also returns when the logo last changed, so the widget's settings name the
-- logo's address with no second query. A new return type needs DROP and CREATE, so the grant is
-- made again.
DROP FUNCTION widget_workspace(text);
--> statement-breakpoint
CREATE FUNCTION widget_workspace(key text)
  RETURNS TABLE (
    id uuid,
    allowed_origins text[],
    signing_secret text,
    widget_title text,
    widget_greeting text,
    widget_away text,
    logo_updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret, w.widget_title, w.widget_greeting,
      w.widget_away, l.updated_at
    FROM workspace AS w
    LEFT JOIN workspace_logo AS l ON l.workspace_id = w.id
    WHERE w.public_key = key AND workspace_access(w.id) = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION widget_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION widget_workspace(text) TO dinghy_app;
