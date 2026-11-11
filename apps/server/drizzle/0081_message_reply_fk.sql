-- A quote points to an earlier message of the same workspace. Deleting that row clears only the
-- quote's column, because the workspace column is part of the key and must stay.
ALTER TABLE "message" ADD CONSTRAINT "message_reply_to_fk"
  FOREIGN KEY ("workspace_id", "reply_to_message_id")
  REFERENCES "message" ("workspace_id", "id")
  ON DELETE SET NULL ("reply_to_message_id");
--> statement-breakpoint
-- An edit checks whether an email carrying the reply is being sent now, and a reply's info reads
-- when a transcript of its conversation went.
GRANT SELECT (claimed_until, conversation_id) ON alert_delivery TO dinghy_app;
