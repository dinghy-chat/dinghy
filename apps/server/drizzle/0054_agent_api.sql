CREATE TABLE "api_key" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "api_key_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_key_name_length" CHECK (char_length("api_key"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "webhook" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"last_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_one_author";--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "needs_webhook" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "author_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "page_context" jsonb;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhook_fk" FOREIGN KEY ("workspace_id","webhook_id") REFERENCES "public"."webhook"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_webhook_idx" ON "webhook_delivery" USING btree ("workspace_id","webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "webhook_delivery" USING btree ("next_attempt_at") WHERE "webhook_delivery"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_delivery_finished_idx" ON "webhook_delivery" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_conversation_idx" ON "webhook_delivery" USING btree ("workspace_id","conversation_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_message_idx" ON "webhook_delivery" USING btree ("workspace_id","message_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_api_key_fk" FOREIGN KEY ("workspace_id","author_api_key_id") REFERENCES "public"."api_key"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_needs_webhook_idx" ON "event" USING btree ("created_at") WHERE "event"."needs_webhook";--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_api_key_client_key" UNIQUE("workspace_id","author_api_key_id","client_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_one_author" CHECK (num_nonnulls("message"."author_operator_id", "message"."author_visitor_id", "message"."author_api_key_id") = 1);