ALTER TABLE lifecycle_email ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON lifecycle_email TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- A Stripe webhook queues emails in the app, and the worker queues them too when it applies Stripe's
-- state or makes a workspace read-only.
GRANT SELECT, INSERT ON lifecycle_email TO dinghy_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lifecycle_email TO dinghy_worker;
--> statement-breakpoint
-- The worker finds due emails across workspaces and claims them, as with subscriptions.
CREATE POLICY worker_lifecycle_emails ON lifecycle_email TO dinghy_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- As before, with the new tenant table. A new tenant table must be added here: a test checks that
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
-- The emails of lifecycles already under way. One that the notice column says went out counts as
-- sent, and a reminder whose day has passed is left out. Workspaces paid before this migration get
-- only the onboarding emails still ahead of them.
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at, sent_at)
  SELECT workspace_id, 'payment_failed', payment_failed_at, payment_failed_at,
    CASE WHEN notice = 'payment_failed' THEN now() END
  FROM subscription
  WHERE payment_failed_at IS NOT NULL AND read_only_at IS NULL;
--> statement-breakpoint
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at)
  SELECT s.workspace_id, step.kind::lifecycle_email_kind, s.payment_failed_at,
    s.payment_failed_at + step.after
  FROM subscription AS s
  CROSS JOIN (VALUES ('payment_reminder', interval '3 days'), ('payment_last_day', interval '6 days'))
    AS step (kind, after)
  WHERE s.payment_failed_at IS NOT NULL AND s.read_only_at IS NULL
    AND s.payment_failed_at + step.after > now();
--> statement-breakpoint
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at, sent_at)
  SELECT workspace_id, 'read_only', read_only_at, read_only_at,
    CASE WHEN notice IN ('read_only', 'deletion_soon') THEN now() END
  FROM subscription
  WHERE read_only_at IS NOT NULL;
--> statement-breakpoint
-- Read-only now lasts 90 days, so a workspace warned under the old 30 days is warned again.
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at)
  SELECT s.workspace_id, step.kind::lifecycle_email_kind, s.read_only_at, s.read_only_at + step.after
  FROM subscription AS s
  CROSS JOIN (VALUES ('deletion_30', interval '60 days'), ('deletion_7', interval '83 days'))
    AS step (kind, after)
  WHERE s.read_only_at IS NOT NULL;
--> statement-breakpoint
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at)
  SELECT s.workspace_id, step.kind::lifecycle_email_kind, s.paid_at, s.paid_at + step.after
  FROM subscription AS s
  CROSS JOIN (VALUES
    ('install', interval '1 day'),
    ('team', interval '3 days'),
    ('check_in', interval '7 days'),
    ('review', interval '30 days')
  ) AS step (kind, after)
  WHERE s.paid_at IS NOT NULL AND s.read_only_at IS NULL AND s.paid_at + step.after > now();
--> statement-breakpoint
INSERT INTO lifecycle_email (workspace_id, kind, occurrence_at, due_at)
  SELECT workspace_id, 'ending_soon', current_period_end, current_period_end - interval '3 days'
  FROM subscription
  WHERE cancel_at_period_end AND read_only_at IS NULL AND current_period_end IS NOT NULL
    AND current_period_end - interval '3 days' > now();
