CREATE TYPE "public"."alert_channel" AS ENUM('push', 'email');--> statement-breakpoint
CREATE TYPE "public"."alert_outcome" AS ENUM('sent', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "alert_delivery" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_seq" bigint NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"operator_id" uuid,
	"visitor_id" uuid,
	"channel" "alert_channel" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" "alert_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_delivery_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "alert_delivery_recipient_key" UNIQUE NULLS NOT DISTINCT("workspace_id","event_seq","channel","operator_id","visitor_id"),
	CONSTRAINT "alert_delivery_one_recipient" CHECK (num_nonnulls("alert_delivery"."operator_id", "alert_delivery"."visitor_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "email_stop" (
	"workspace_id" uuid NOT NULL,
	"address_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_stop_workspace_id_address_hash_pk" PRIMARY KEY("workspace_id","address_hash")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "needs_alert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD COLUMN "alert_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_operator_fk" FOREIGN KEY ("workspace_id","operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_stop" ADD CONSTRAINT "email_stop_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_delivery_due_idx" ON "alert_delivery" USING btree ("next_attempt_at") WHERE "alert_delivery"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "alert_delivery_finished_idx" ON "alert_delivery" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_conversation_idx" ON "alert_delivery" USING btree ("workspace_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_visitor_idx" ON "alert_delivery" USING btree ("workspace_id","visitor_id","created_at");--> statement-breakpoint
CREATE INDEX "push_subscription_operator_idx" ON "push_subscription" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "event_needs_alert_idx" ON "event" USING btree ("created_at") WHERE "event"."needs_alert";--> statement-breakpoint
CREATE INDEX "event_created_idx" ON "event" USING btree ("created_at");