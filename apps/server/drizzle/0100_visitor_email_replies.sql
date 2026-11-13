CREATE TABLE "reply_address" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"visitor_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_address_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "reply_address_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_address" ADD CONSTRAINT "reply_address_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_address_conversation_idx" ON "reply_address" USING btree ("workspace_id","conversation_id");--> statement-breakpoint
CREATE INDEX "reply_address_visitor_idx" ON "reply_address" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE INDEX "reply_address_last_used_idx" ON "reply_address" USING btree ("last_used_at");