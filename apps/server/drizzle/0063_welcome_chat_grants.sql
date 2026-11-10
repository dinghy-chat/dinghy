-- A welcome link joins two workspaces, so each side sees the row while it works in its own context.
ALTER TABLE welcome_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON welcome_link TO dinghy_app, dinghy_worker
  USING (customer_workspace_id = current_workspace_id() OR founder_workspace_id = current_workspace_id())
  WITH CHECK (customer_workspace_id = current_workspace_id() OR founder_workspace_id = current_workspace_id());
--> statement-breakpoint
-- Signup writes the row, and a reply reads it. It goes with either conversation, by the foreign keys'
-- cascade, so nothing deletes it directly.
GRANT SELECT, INSERT ON welcome_link TO dinghy_app;
--> statement-breakpoint
-- The founder's side of a welcome chat names the other workspace and whether it takes messages,
-- which the tenant policy on workspace hides. The customer's side learns only which side it is.
CREATE FUNCTION welcome_chat(target uuid)
  RETURNS TABLE (founder_side boolean, workspace_name text, access text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT l.founder_workspace_id = current_workspace_id(),
      CASE WHEN l.founder_workspace_id = current_workspace_id() THEN w.name END,
      CASE WHEN l.founder_workspace_id = current_workspace_id() THEN workspace_access(w.id) END
    FROM welcome_link AS l
    JOIN workspace AS w ON w.id = l.customer_workspace_id
    WHERE (l.founder_workspace_id = current_workspace_id() AND l.founder_conversation_id = target)
       OR (l.customer_workspace_id = current_workspace_id() AND l.customer_conversation_id = target)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION welcome_chat(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION welcome_chat(uuid) TO dinghy_app;
