-- The widget has only a public key, so it has no workspace context yet. The function runs as
-- its owner, which bypasses the policies, so it returns only what the widget routes need.
CREATE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    WHERE w.public_key = key
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION widget_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION widget_workspace(text) TO dinghy_app;
