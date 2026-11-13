ALTER TABLE label ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON label TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE conversation_label ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_label TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- Every member adds a label and puts it on conversations. Owners and admins rename and delete them,
-- which the app checks.
GRANT SELECT, INSERT, UPDATE, DELETE ON label TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON conversation_label TO dinghy_app;
--> statement-breakpoint
-- A webhook's conversation names its labels, and the worker builds that payload.
GRANT SELECT ON label, conversation_label TO dinghy_worker;
--> statement-breakpoint
-- The new columns of webhook_delivery need no grant: each role's grant on it covers every column.
--
-- As before, with label and conversation_label.
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
          -- The deletion email needs the owners, so the purge waits while it retries. A mail
          -- server that stays down for 3 days must not keep the data, so it waits no longer.
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_email AS e
            WHERE e.workspace_id = w.id AND e.kind = 'deleted' AND e.sent_at IS NULL
              AND e.due_at > now() - interval '3 days'
          )
        FOR UPDATE OF w SKIP LOCKED
      LOOP
        INSERT INTO storage_deletion (workspace_id, storage_key)
          SELECT workspace_id, storage_key FROM attachment WHERE workspace_id = target;
        DELETE FROM alert_delivery WHERE workspace_id = target;
        DELETE FROM webhook_delivery WHERE workspace_id = target;
        DELETE FROM webhook WHERE workspace_id = target;
        DELETE FROM draft_reply WHERE workspace_id = target;
        DELETE FROM attachment WHERE workspace_id = target;
        DELETE FROM message WHERE workspace_id = target;
        DELETE FROM conversation_label WHERE workspace_id = target;
        -- A conversation names the key that handed it off, so it goes before the keys.
        DELETE FROM conversation WHERE workspace_id = target;
        DELETE FROM api_key_credential WHERE workspace_id = target;
        DELETE FROM api_key WHERE workspace_id = target;
        DELETE FROM ip_block WHERE workspace_id = target;
        DELETE FROM email_stop WHERE workspace_id = target;
        DELETE FROM invite WHERE workspace_id = target;
        DELETE FROM event WHERE workspace_id = target;
        DELETE FROM visitor WHERE workspace_id = target;
        DELETE FROM stripe_event WHERE workspace_id = target;
        DELETE FROM lifecycle_email WHERE workspace_id = target;
        DELETE FROM subscription WHERE workspace_id = target;
        DELETE FROM saved_reply WHERE workspace_id = target;
        DELETE FROM label WHERE workspace_id = target;
        DELETE FROM workspace_member WHERE workspace_id = target;
        IF NOT EXISTS (SELECT 1 FROM storage_deletion WHERE workspace_id = target) THEN
          DELETE FROM workspace WHERE id = target;
          removed := removed + 1;
        END IF;
      END LOOP;
      RETURN removed;
    END
  $$;
