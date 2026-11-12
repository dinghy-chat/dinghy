ALTER TABLE api_key_credential ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_key_credential TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app issues a grant's codes and tokens, marks a code or a refresh token used, and deletes a
-- grant's tokens when it is revoked or a refresh token is replayed.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_credential TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON api_key_credential TO dinghy_worker;
--> statement-breakpoint
-- The worker prunes expired tokens across workspaces, which needs it to find them first.
CREATE POLICY worker_find_credentials ON api_key_credential FOR SELECT TO dinghy_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_credentials ON api_key_credential FOR DELETE TO dinghy_worker USING (true);
--> statement-breakpoint
ALTER TABLE draft_reply ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON draft_reply TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- A key writes a draft, a visitor's message marks it stale, an operator sends or discards it, and a
-- conversation's or a contact's delete removes it.
GRANT SELECT, INSERT, UPDATE, DELETE ON draft_reply TO dinghy_app;
--> statement-breakpoint
ALTER TABLE widget_site_seen ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON widget_site_seen TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The widget's beat records a site, and Settings lists them. The purge needs no grant: the rows go
-- with their workspace row, by the foreign key's cascade.
GRANT SELECT, INSERT, UPDATE ON widget_site_seen TO dinghy_app;
--> statement-breakpoint
-- The new columns of api_key, conversation, visitor, workspace and webhook_delivery need no grant:
-- each role's grant on those tables covers every column.
--
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
-- An owner, an admin or a Setup key replays a delivery: the app inserts its new row, under the
-- tenant policy that already covers dinghy_app.
GRANT INSERT ON webhook_delivery TO dinghy_app;
--> statement-breakpoint
-- The worker deletes an OAuth grant that nobody ever used, such as one approved and never redeemed.
-- A grant that was never used authored nothing, so no message, draft or webhook names it.
GRANT DELETE ON api_key TO dinghy_worker;
--> statement-breakpoint
CREATE POLICY worker_find_unused_grants ON api_key FOR SELECT TO dinghy_worker
  USING (source = 'oauth' AND last_used_at IS NULL);
--> statement-breakpoint
CREATE POLICY worker_prune_unused_grants ON api_key FOR DELETE TO dinghy_worker
  USING (source = 'oauth' AND last_used_at IS NULL);
--> statement-breakpoint
-- A webhook's conversation names its handler: the key that took part last, by a message (a note is
-- one) or a draft. The worker builds that payload, so it reads drafts too, under the tenant policy.
GRANT SELECT ON draft_reply TO dinghy_worker;
--> statement-breakpoint
-- The event `conversation.bot_resumed` is now `conversation.given_back`. Only builds before a
-- release could store the old name.
UPDATE webhook SET events = array_replace(events, 'conversation.bot_resumed', 'conversation.given_back')
  WHERE 'conversation.bot_resumed' = ANY(events);
--> statement-breakpoint
UPDATE webhook_delivery SET type = 'conversation.given_back' WHERE type = 'conversation.bot_resumed';
