-- The worker finds deleted workspaces whose billing it has not cleared, across workspaces. It sees
-- only the IDs and Stripe customers, and only once the deletion is older than `cutoff`.
CREATE FUNCTION deleted_billing_to_clear(cutoff timestamptz, max_rows integer)
  RETURNS TABLE (workspace_id uuid, stripe_customer_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.workspace_id, s.stripe_customer_id
    FROM subscription AS s
    JOIN workspace AS w ON w.id = s.workspace_id
    WHERE w.deleted_at IS NOT NULL AND w.deleted_at <= cutoff AND s.billing_cleared_at IS NULL
    ORDER BY w.deleted_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION deleted_billing_to_clear(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION deleted_billing_to_clear(timestamptz, integer) TO dinghy_worker;
--> statement-breakpoint
-- As before, except that a workspace with a Stripe customer waits until the worker has cleared its
-- billing, so a Checkout opened as it was deleted cannot be paid once no row is left to cancel it.
-- A workspace with no subscription row, as on a self-hosted install, purges at once.
CREATE OR REPLACE FUNCTION purge_deleted_workspaces()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    DECLARE
      target uuid;
      removed integer := 0;
    BEGIN
      FOR target IN
        SELECT w.id FROM workspace AS w
        WHERE w.deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM subscription AS s
            WHERE s.workspace_id = w.id AND s.billing_cleared_at IS NULL
          )
        FOR UPDATE OF w SKIP LOCKED
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
