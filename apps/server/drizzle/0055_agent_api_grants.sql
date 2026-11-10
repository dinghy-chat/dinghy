ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_key TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app creates, checks and revokes keys, and notes when one was last used. An import writes
-- them too. The worker reads a key's name for a webhook's message.
GRANT SELECT, INSERT, UPDATE ON api_key TO dinghy_app;
--> statement-breakpoint
GRANT SELECT ON api_key TO dinghy_worker;
--> statement-breakpoint
ALTER TABLE webhook ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON webhook TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook TO dinghy_app;
--> statement-breakpoint
GRANT SELECT ON webhook TO dinghy_worker;
--> statement-breakpoint
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON webhook_delivery TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app only lists a webhook's recent deliveries in Settings.
GRANT SELECT ON webhook_delivery TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_delivery TO dinghy_worker;
--> statement-breakpoint
-- The worker claims due deliveries and prunes finished ones across workspaces, as with alerts.
CREATE POLICY worker_deliveries ON webhook_delivery TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (needs_webhook) ON event TO dinghy_worker;
--> statement-breakpoint
-- As before, with the new tenant tables. A new tenant table must be added here: a test checks that
-- no tenant table keeps a deleted workspace's rows.
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
        DELETE FROM webhook_delivery WHERE workspace_id = target;
        DELETE FROM webhook WHERE workspace_id = target;
        DELETE FROM attachment WHERE workspace_id = target;
        DELETE FROM message WHERE workspace_id = target;
        DELETE FROM api_key WHERE workspace_id = target;
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
