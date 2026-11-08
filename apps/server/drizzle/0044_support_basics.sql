CREATE TABLE "chat_link" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"visitor_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_link_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "chat_link_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "device" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "last_page" text;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "widget_title" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "widget_greeting" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "widget_away" text;--> statement-breakpoint
ALTER TABLE "chat_link" ADD CONSTRAINT "chat_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_link" ADD CONSTRAINT "chat_link_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_link" ADD CONSTRAINT "chat_link_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_link_conversation_idx" ON "chat_link" USING btree ("workspace_id","conversation_id");--> statement-breakpoint
CREATE INDEX "chat_link_visitor_idx" ON "chat_link" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE INDEX "chat_link_expires_idx" ON "chat_link" USING btree ("expires_at");