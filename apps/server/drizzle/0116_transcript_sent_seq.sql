ALTER TABLE "conversation" ADD COLUMN "transcript_sent_seq" bigint;
--> statement-breakpoint
-- Transcripts sent before this column, while their deliveries are still kept.
UPDATE conversation AS c SET transcript_sent_seq = sent.to_seq
FROM (
  SELECT workspace_id, conversation_id, max(covered_to_seq) AS to_seq FROM alert_delivery
  WHERE channel::text = 'transcript' AND outcome = 'sent' AND covered_to_seq IS NOT NULL
  GROUP BY workspace_id, conversation_id
) AS sent
WHERE c.workspace_id = sent.workspace_id AND c.id = sent.conversation_id;
--> statement-breakpoint
-- The worker moves it when it sends a transcript, in the conversation's workspace only.
GRANT UPDATE (transcript_sent_seq) ON conversation TO dinghy_worker;
