-- A deleted or read-only workspace has no widget, so it gets the same answer as an unknown key.
CREATE OR REPLACE FUNCTION widget_workspace(key text)
  RETURNS TABLE (id uuid, allowed_origins text[], signing_secret text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.allowed_origins, w.signing_secret
    FROM workspace AS w
    LEFT JOIN subscription AS s ON s.workspace_id = w.id
    WHERE w.public_key = key AND w.active AND w.deleted_at IS NULL AND s.read_only_at IS NULL
  $$;
--> statement-breakpoint
-- The return type changes again: the app also needs to know which workspaces are read-only.
DROP FUNCTION operator_workspaces(uuid);
--> statement-breakpoint
CREATE FUNCTION operator_workspaces(target_operator uuid)
  RETURNS TABLE (workspace_id uuid, role member_role, active boolean, read_only boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.workspace_id, m.role, w.active, s.read_only_at IS NOT NULL
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
-- The worker finds subscriptions with lifecycle work across workspaces, claims them, and moves them
-- to read-only. It reads the state from Stripe again before a deletion.
CREATE POLICY worker_lifecycle ON subscription TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, UPDATE ON subscription TO dinghy_worker;
--> statement-breakpoint
-- In a workspace's own context only, through the tenant policy.
GRANT UPDATE (active, deleted_at) ON workspace TO dinghy_worker;
--> statement-breakpoint
-- Removes the data of each deleted workspace that no other transaction holds, and queues its stored
-- images. A workspace row goes last, once the worker has removed its images from the store. It runs
-- as the tables' owner, and acts only on a workspace that is already marked deleted. A new tenant
-- table must be added here: a test checks that no tenant table keeps a deleted workspace's rows.
CREATE FUNCTION purge_deleted_workspaces()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    DECLARE
      target uuid;
      removed integer := 0;
    BEGIN
      FOR target IN
        SELECT id FROM workspace WHERE deleted_at IS NOT NULL FOR UPDATE SKIP LOCKED
      LOOP
        INSERT INTO storage_deletion (workspace_id, storage_key)
          SELECT workspace_id, storage_key FROM attachment WHERE workspace_id = target;
        DELETE FROM alert_delivery WHERE workspace_id = target;
        DELETE FROM attachment WHERE workspace_id = target;
        DELETE FROM message WHERE workspace_id = target;
        DELETE FROM conversation WHERE workspace_id = target;
        DELETE FROM ip_block WHERE workspace_id = target;
        DELETE FROM email_stop WHERE workspace_id = target;
        DELETE FROM invite WHERE workspace_id = target;
        DELETE FROM event WHERE workspace_id = target;
        DELETE FROM visitor WHERE workspace_id = target;
        DELETE FROM stripe_event WHERE workspace_id = target;
        DELETE FROM subscription WHERE workspace_id = target;
        DELETE FROM workspace_member WHERE workspace_id = target;
        IF NOT EXISTS (SELECT 1 FROM storage_deletion WHERE workspace_id = target) THEN
          DELETE FROM workspace WHERE id = target;
          removed := removed + 1;
        END IF;
      END LOOP;
      RETURN removed;
    END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_deleted_workspaces() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_deleted_workspaces() TO dinghy_worker;
--> statement-breakpoint
-- Stage 25 activated a workspace only when a payment cleared, so an active one with a subscription
-- has paid.
UPDATE subscription AS s SET paid_at = s.created_at
  FROM workspace AS w
  WHERE w.id = s.workspace_id AND w.active AND s.paid_at IS NULL;
