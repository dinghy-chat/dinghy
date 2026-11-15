-- A visitor's contact fields were written by host tokens only, at the token's issue time.
UPDATE visitor AS v SET field_times = coalesce((
  SELECT jsonb_object_agg(fields.name, v.identity_issued_at * 1000) FROM (
    SELECT 'name' AS name WHERE v.name IS NOT NULL
    UNION ALL SELECT 'email' WHERE v.email IS NOT NULL
    UNION ALL SELECT 'attributes.' || key FROM jsonb_object_keys(
      CASE WHEN jsonb_typeof(v.attributes) = 'object' THEN v.attributes ELSE '{}'::jsonb END
    ) AS key
  ) AS fields
), '{}'::jsonb)
WHERE v.identity_issued_at IS NOT NULL;
--> statement-breakpoint
-- An outbound message's conversation or message can be deleted. That clears only its column,
-- because the workspace column is part of the key and must stay.
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_conversation_fk"
  FOREIGN KEY ("workspace_id", "conversation_id")
  REFERENCES "conversation" ("workspace_id", "id")
  ON DELETE SET NULL ("conversation_id");
--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_message_fk"
  FOREIGN KEY ("workspace_id", "message_id")
  REFERENCES "message" ("workspace_id", "id")
  ON DELETE SET NULL ("message_id");
--> statement-breakpoint
ALTER TABLE outbound_message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbound_message TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE outbound_dedupe ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbound_dedupe TO dinghy_app, dinghy_worker
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- The app sends, cancels and updates outbound messages, and a block forgets them. The worker's due
-- messages go through the app's role too, as they write messages.
GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_message, outbound_dedupe TO dinghy_app;
--> statement-breakpoint
-- A webhook's body names the outbound message. The worker finds the due ones across workspaces, and
-- removes the bodies of old ones.
GRANT SELECT ON outbound_message, outbound_dedupe TO dinghy_worker;
--> statement-breakpoint
GRANT UPDATE (body) ON outbound_message TO dinghy_worker;
--> statement-breakpoint
CREATE POLICY worker_find_outbound_messages ON outbound_message FOR SELECT TO dinghy_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY worker_prune_outbound_messages ON outbound_message FOR UPDATE TO dinghy_worker
  USING (true) WITH CHECK (true);
