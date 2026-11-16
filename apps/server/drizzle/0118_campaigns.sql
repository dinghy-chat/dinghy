CREATE TABLE "campaign" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"author_operator_id" uuid,
	"author_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"live_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "campaign_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "campaign_key_key" UNIQUE("workspace_id","key"),
	CONSTRAINT "campaign_one_author" CHECK (num_nonnulls("campaign"."author_operator_id", "campaign"."author_api_key_id") = 1),
	CONSTRAINT "campaign_status" CHECK ("campaign"."status" in ('draft', 'live', 'paused', 'ended')),
	CONSTRAINT "campaign_key_format" CHECK ("campaign"."key" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "campaign_name_length" CHECK (char_length("campaign"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "campaign_day" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"day" date NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"entered" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"read" integer DEFAULT 0 NOT NULL,
	"replied" integer DEFAULT 0 NOT NULL,
	"dismissed" integer DEFAULT 0 NOT NULL,
	"goal_reached" integer DEFAULT 0 NOT NULL,
	"conversations_started" integer DEFAULT 0 NOT NULL,
	"clicks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "campaign_day_workspace_id_campaign_id_day_variant_pk" PRIMARY KEY("workspace_id","campaign_id","day","variant")
);
--> statement-breakpoint
CREATE TABLE "campaign_run" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"occurrence" timestamp with time zone NOT NULL,
	"cursor" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_run_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "campaign_run_occurrence_key" UNIQUE("workspace_id","campaign_id","occurrence")
);
--> statement-breakpoint
CREATE TABLE "campaign_trigger" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"field" text NOT NULL,
	CONSTRAINT "campaign_trigger_workspace_id_campaign_id_field_pk" PRIMARY KEY("workspace_id","campaign_id","field")
);
--> statement-breakpoint
CREATE TABLE "contact_event" (
	"workspace_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"recent_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "contact_event_workspace_id_visitor_id_name_pk" PRIMARY KEY("workspace_id","visitor_id","name")
);
--> statement-breakpoint
ALTER TABLE "outbound_message" DROP CONSTRAINT "outbound_message_status_reason";--> statement-breakpoint
ALTER TABLE "webhook_delivery" DROP CONSTRAINT "webhook_delivery_subject";--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "campaign_run_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "from_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "goal_reached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "email_if_unread_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "campaigns_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "campaigns_paused_by" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "campaign_gap_hours" smallint DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_author_operator_fk" FOREIGN KEY ("workspace_id","author_operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_author_api_key_fk" FOREIGN KEY ("workspace_id","author_api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_day" ADD CONSTRAINT "campaign_day_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_day" ADD CONSTRAINT "campaign_day_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_run" ADD CONSTRAINT "campaign_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_run" ADD CONSTRAINT "campaign_run_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_trigger" ADD CONSTRAINT "campaign_trigger_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_trigger" ADD CONSTRAINT "campaign_trigger_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_live_idx" ON "campaign" USING btree ("workspace_id") WHERE "campaign"."status" = 'live';--> statement-breakpoint
CREATE INDEX "campaign_api_key_idx" ON "campaign" USING btree ("workspace_id","author_api_key_id");--> statement-breakpoint
CREATE INDEX "campaign_run_open_idx" ON "campaign_run" USING btree ("created_at") WHERE "campaign_run"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "campaign_trigger_field_idx" ON "campaign_trigger" USING btree ("workspace_id","field");--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_campaign_run_fk" FOREIGN KEY ("workspace_id","campaign_run_id") REFERENCES "public"."campaign_run"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_message_campaign_idx" ON "outbound_message" USING btree ("workspace_id","campaign_id","visitor_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_message_campaign_sent_idx" ON "outbound_message" USING btree ("workspace_id","visitor_id","sent_at") WHERE "outbound_message"."campaign_id" is not null and "outbound_message"."sent_at" is not null;--> statement-breakpoint
CREATE INDEX "webhook_delivery_campaign_idx" ON "webhook_delivery" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_run_visitor_key" UNIQUE("workspace_id","campaign_run_id","visitor_id");--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_variant" CHECK (("outbound_message"."variant" is null) or ("outbound_message"."campaign_id" is not null));--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_status_reason" CHECK ("outbound_message"."status_reason" in ('open_conversation', 'open_conversation_skipped', 'human_handling', 'bots_paused', 'blocked', 'permission_revoked', 'workspace_inactive', 'unless_matched', 'cancelled_by_request', 'conversation_deleted', 'opted_out', 'audience_unmatched', 'frequency_capped', 'goal_reached', 'outside_business_hours', 'outside_send_window', 'campaign_paused', 'campaign_ended', 'control_group'));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_one_subject" CHECK (num_nonnulls("webhook_delivery"."conversation_id", "webhook_delivery"."outbound_message_id", "webhook_delivery"."campaign_id") = 1);--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_campaign_gap_hours" CHECK ("workspace"."campaign_gap_hours" between 0 and 720);