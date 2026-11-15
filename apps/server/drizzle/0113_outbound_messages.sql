CREATE TABLE "outbound_dedupe" (
	"workspace_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"outbound_message_id" uuid NOT NULL,
	CONSTRAINT "outbound_dedupe_workspace_id_visitor_id_dedupe_key_pk" PRIMARY KEY("workspace_id","visitor_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "outbound_message" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"visitor_id" uuid NOT NULL,
	"author_operator_id" uuid,
	"author_api_key_id" uuid,
	"via" text,
	"sender_kind" text NOT NULL,
	"sender_operator_id" uuid,
	"body" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_button" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"start_conversation" text NOT NULL,
	"show" text NOT NULL,
	"if_conversation_open" text NOT NULL,
	"assign_on_reply" boolean NOT NULL,
	"send_email" boolean NOT NULL,
	"dedupe_key" text,
	"client_id" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unless" jsonb,
	"expires_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"conversation_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_message_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "outbound_message_operator_client_key" UNIQUE("workspace_id","author_operator_id","client_id"),
	CONSTRAINT "outbound_message_api_key_client_key" UNIQUE("workspace_id","author_api_key_id","client_id"),
	CONSTRAINT "outbound_message_one_author" CHECK (num_nonnulls("outbound_message"."author_operator_id", "outbound_message"."author_api_key_id") = 1),
	CONSTRAINT "outbound_message_sender" CHECK (("outbound_message"."sender_kind" = 'member') = ("outbound_message"."sender_operator_id" is not null)),
	CONSTRAINT "outbound_message_sender_kind" CHECK ("outbound_message"."sender_kind" in ('member', 'team', 'author')),
	CONSTRAINT "outbound_message_status" CHECK ("outbound_message"."status" in ('scheduled', 'sent', 'delivered', 'read', 'replied', 'dismissed', 'cancelled', 'expired')),
	CONSTRAINT "outbound_message_status_reason" CHECK ("outbound_message"."status_reason" in ('open_conversation', 'open_conversation_skipped', 'human_handling', 'bots_paused', 'blocked', 'permission_revoked', 'workspace_inactive', 'unless_matched', 'audience_unmatched', 'frequency_capped', 'goal_reached', 'outside_business_hours', 'campaign_paused', 'campaign_ended', 'opted_out', 'cancelled_by_request', 'conversation_deleted')),
	CONSTRAINT "outbound_message_start_conversation" CHECK ("outbound_message"."start_conversation" in ('on_reply', 'now')),
	CONSTRAINT "outbound_message_show" CHECK ("outbound_message"."show" in ('badge', 'preview', 'chat')),
	CONSTRAINT "outbound_message_if_conversation_open" CHECK ("outbound_message"."if_conversation_open" in ('hold', 'join', 'skip')),
	CONSTRAINT "outbound_message_via" CHECK ("outbound_message"."via" = 'mcp'),
	CONSTRAINT "outbound_message_body_length" CHECK (char_length("outbound_message"."body") between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "permissions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "started_by" text DEFAULT 'visitor' NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "field_times" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "outbound_message_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_dedupe" ADD CONSTRAINT "outbound_dedupe_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_dedupe" ADD CONSTRAINT "outbound_dedupe_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_dedupe" ADD CONSTRAINT "outbound_dedupe_outbound_message_fk" FOREIGN KEY ("workspace_id","outbound_message_id") REFERENCES "public"."outbound_message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_author_operator_fk" FOREIGN KEY ("workspace_id","author_operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_author_api_key_fk" FOREIGN KEY ("workspace_id","author_api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_sender_fk" FOREIGN KEY ("workspace_id","sender_operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_dedupe_outbound_message_idx" ON "outbound_dedupe" USING btree ("workspace_id","outbound_message_id");--> statement-breakpoint
CREATE INDEX "outbound_message_created_idx" ON "outbound_message" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "outbound_message_visitor_idx" ON "outbound_message" USING btree ("workspace_id","visitor_id","created_at","id");--> statement-breakpoint
CREATE INDEX "outbound_message_waiting_idx" ON "outbound_message" USING btree ("workspace_id","visitor_id") WHERE "outbound_message"."status" in ('scheduled', 'sent', 'delivered', 'read') and "outbound_message"."conversation_id" is null;--> statement-breakpoint
CREATE INDEX "outbound_message_due_idx" ON "outbound_message" USING btree ("due_at") WHERE "outbound_message"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "outbound_message_expires_idx" ON "outbound_message" USING btree ("expires_at") WHERE "outbound_message"."status" in ('scheduled', 'sent', 'delivered') and "outbound_message"."conversation_id" is null;--> statement-breakpoint
CREATE INDEX "outbound_message_body_idx" ON "outbound_message" USING btree ("created_at") WHERE "outbound_message"."body" is not null;--> statement-breakpoint
CREATE INDEX "outbound_message_dedupe_key_idx" ON "outbound_message" USING btree ("workspace_id","dedupe_key") WHERE "outbound_message"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "outbound_message_api_key_idx" ON "outbound_message" USING btree ("workspace_id","author_api_key_id");--> statement-breakpoint
CREATE INDEX "outbound_message_conversation_idx" ON "outbound_message" USING btree ("workspace_id","conversation_id");--> statement-breakpoint
CREATE INDEX "outbound_message_message_idx" ON "outbound_message" USING btree ("workspace_id","message_id");--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_outbound_message_fk" FOREIGN KEY ("workspace_id","outbound_message_id") REFERENCES "public"."outbound_message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_outbound_message_idx" ON "webhook_delivery" USING btree ("workspace_id","outbound_message_id");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_permissions" CHECK ("api_key"."permissions" <@ array['send_as_member', 'send_email']::text[]);--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_started_by" CHECK ("conversation"."started_by" in ('visitor', 'team'));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_subject" CHECK (("webhook_delivery"."conversation_id" is null) <> ("webhook_delivery"."outbound_message_id" is null));