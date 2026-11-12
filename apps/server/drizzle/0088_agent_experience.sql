CREATE TABLE "api_key_credential" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"family_id" uuid,
	"code_challenge" text,
	"redirect_uri" text,
	"resource" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_credential_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "api_key_credential_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "api_key_credential_kind" CHECK ("api_key_credential"."kind" in ('code', 'access', 'refresh')),
	CONSTRAINT "api_key_credential_code" CHECK ("api_key_credential"."kind" = 'code' or num_nonnulls("api_key_credential"."code_challenge", "api_key_credential"."redirect_uri", "api_key_credential"."resource") = 0)
);
--> statement-breakpoint
CREATE TABLE "draft_reply" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"body" text NOT NULL,
	"reply_to_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone,
	"resolved" text,
	"resolved_by_operator_id" uuid,
	"resolved_at" timestamp with time zone,
	"sent_message_id" uuid,
	CONSTRAINT "draft_reply_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "draft_reply_client_key" UNIQUE("workspace_id","api_key_id","client_id"),
	CONSTRAINT "draft_reply_body_length" CHECK (char_length("draft_reply"."body") between 1 and 10000),
	CONSTRAINT "draft_reply_resolved" CHECK ("draft_reply"."resolved" in ('sent', 'discarded')),
	CONSTRAINT "draft_reply_resolved_at" CHECK (("draft_reply"."resolved" is null) = ("draft_reply"."resolved_at" is null)),
	CONSTRAINT "draft_reply_sent_message" CHECK (coalesce("draft_reply"."resolved" = 'sent', false) = ("draft_reply"."sent_message_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "widget_site_seen" (
	"workspace_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_site_seen_workspace_id_origin_pk" PRIMARY KEY("workspace_id","origin")
);
--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "source" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
-- Keys made before this keep sending, so no bot changes behavior. New keys draft.
ALTER TABLE "api_key" ADD COLUMN "reply_mode" text DEFAULT 'send' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "reply_mode" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "human_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "handoff_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "response_excerpt" text;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "replay_of" uuid;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "replayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "bots_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "bots_paused_by" uuid;--> statement-breakpoint
ALTER TABLE "api_key_credential" ADD CONSTRAINT "api_key_credential_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_credential" ADD CONSTRAINT "api_key_credential_api_key_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_api_key_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_reply_to_fk" FOREIGN KEY ("workspace_id","reply_to_message_id") REFERENCES "public"."message"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_sent_message_fk" FOREIGN KEY ("workspace_id","sent_message_id") REFERENCES "public"."message"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_resolved_by_fk" FOREIGN KEY ("workspace_id","resolved_by_operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_site_seen" ADD CONSTRAINT "widget_site_seen_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_credential_api_key_idx" ON "api_key_credential" USING btree ("workspace_id","api_key_id");--> statement-breakpoint
CREATE INDEX "api_key_credential_expires_idx" ON "api_key_credential" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "draft_reply_conversation_idx" ON "draft_reply" USING btree ("workspace_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "draft_reply_open_idx" ON "draft_reply" USING btree ("workspace_id","conversation_id") WHERE "draft_reply"."resolved" is null;--> statement-breakpoint
CREATE INDEX "draft_reply_reply_to_idx" ON "draft_reply" USING btree ("workspace_id","reply_to_message_id");--> statement-breakpoint
CREATE INDEX "draft_reply_sent_message_idx" ON "draft_reply" USING btree ("workspace_id","sent_message_id");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_handoff_api_key_fk" FOREIGN KEY ("workspace_id","handoff_by_api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_handoff_api_key_idx" ON "conversation" USING btree ("workspace_id","handoff_by_api_key_id");--> statement-breakpoint
CREATE INDEX "message_api_key_conversation_idx" ON "message" USING btree ("workspace_id","conversation_id","seq") WHERE "message"."author_api_key_id" is not null;--> statement-breakpoint
CREATE INDEX "visitor_test_idx" ON "visitor" USING btree ("workspace_id") WHERE "visitor"."is_test";--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_source" CHECK ("api_key"."source" in ('static', 'oauth'));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_reply_mode" CHECK ("api_key"."reply_mode" in ('send', 'draft'));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_token" CHECK (("api_key"."source" = 'static') = ("api_key"."token_hash" is not null));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_client" CHECK (("api_key"."source" = 'oauth') = ("api_key"."client_id" is not null));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_response_excerpt_length" CHECK (char_length("webhook_delivery"."response_excerpt") <= 2048);