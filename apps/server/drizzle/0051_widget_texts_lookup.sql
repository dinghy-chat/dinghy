-- The widget lookup also returns the widget's own words, so the widget's requests read them from the
-- row they already fetch. A new return type needs DROP and CREATE, so the grant is made again.
DROP FUNCTION widget_workspace(text);
--> statement-breakpoint
CREATE FUNCTION widget_workspace(key text)
  RETURNS TABLE (
    id uuid,
    allowed_origins text[],
    signing_secret text,
    widget_title text,
    widget_greeting text,
    widget_away text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret, w.widget_title, w.widget_greeting, w.widget_away
    FROM workspace AS w
    WHERE w.public_key = key AND workspace_access(w.id) = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION widget_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION widget_workspace(text) TO dinghy_app;
