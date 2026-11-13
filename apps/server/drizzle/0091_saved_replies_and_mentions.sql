ALTER TYPE "public"."alert_channel" ADD VALUE 'mention_push';--> statement-breakpoint
ALTER TYPE "public"."alert_channel" ADD VALUE 'mention_email';--> statement-breakpoint
CREATE TABLE "saved_reply" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"shortcut" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_reply_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "saved_reply_shortcut_key" UNIQUE("workspace_id","shortcut"),
	CONSTRAINT "saved_reply_shortcut" CHECK ("saved_reply"."shortcut" ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
	CONSTRAINT "saved_reply_body_length" CHECK (char_length("saved_reply"."body") between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "saved_reply" ADD CONSTRAINT "saved_reply_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;