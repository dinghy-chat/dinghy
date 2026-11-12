CREATE TABLE "conversation_read" (
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"read_seq" bigint NOT NULL,
	CONSTRAINT "conversation_read_workspace_id_conversation_id_operator_id_pk" PRIMARY KEY("workspace_id","conversation_id","operator_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_member_fk" FOREIGN KEY ("workspace_id","operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_read_member_idx" ON "conversation_read" USING btree ("workspace_id","operator_id");--> statement-breakpoint
-- Existing history is read: each current member starts at each conversation's newest message.
INSERT INTO "conversation_read" ("workspace_id", "conversation_id", "operator_id", "read_seq")
SELECT newest.workspace_id, newest.conversation_id, m.operator_id, newest.seq
FROM (
  SELECT workspace_id, conversation_id, max(seq) AS seq FROM "message" GROUP BY workspace_id, conversation_id
) AS newest
JOIN "workspace_member" AS m ON m.workspace_id = newest.workspace_id AND m.removed_at IS NULL;
