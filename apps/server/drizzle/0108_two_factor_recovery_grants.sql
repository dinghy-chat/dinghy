-- Global, as the operator is. The app starts a request on the code screen, cancels one by its link,
-- the banner or a correct code, and marks the pending ones in Settings > Team. An account's delete
-- removes its requests.
GRANT SELECT, INSERT, UPDATE, DELETE ON two_factor_recovery TO dinghy_app;
--> statement-breakpoint
-- The worker sends the reminder and, at the end of the wait, removes two-step sign-in: the secret
-- and the recovery codes, the account's flag and every session.
GRANT SELECT, UPDATE ON two_factor_recovery TO dinghy_worker;
--> statement-breakpoint
GRANT SELECT, DELETE ON operator_two_factor, session TO dinghy_worker;
--> statement-breakpoint
-- updated_at too, which every update of the row sets.
GRANT UPDATE (two_factor_on, asks_two_factor_again, updated_at) ON operator TO dinghy_worker;
--> statement-breakpoint
-- Who a recovery warns: the owners and admins of the account's workspaces, but the account itself.
-- A named lookup across workspaces, as operator_workspaces is, so neither role reads members
-- outside a workspace's context.
CREATE FUNCTION operator_managers(target_operator uuid)
  RETURNS TABLE (operator_id uuid, email text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT o.id, o.email, o.name
    FROM workspace_member AS mine
    JOIN workspace AS w ON w.id = mine.workspace_id
    JOIN workspace_member AS m ON m.workspace_id = mine.workspace_id
    JOIN operator AS o ON o.id = m.operator_id
    WHERE mine.operator_id = target_operator AND mine.removed_at IS NULL AND w.deleted_at IS NULL
      AND m.operator_id <> target_operator AND m.removed_at IS NULL
      AND m.role IN ('owner', 'admin') AND o.deleted_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_managers(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_managers(uuid) TO dinghy_app, dinghy_worker;
