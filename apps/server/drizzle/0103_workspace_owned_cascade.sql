ALTER TABLE "conversation_label" DROP CONSTRAINT "conversation_label_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "label" DROP CONSTRAINT "label_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_reply" DROP CONSTRAINT "saved_reply_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_label" ADD CONSTRAINT "conversation_label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reply" ADD CONSTRAINT "saved_reply_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;