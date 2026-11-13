CREATE TYPE "public"."label_color" AS ENUM('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple');--> statement-breakpoint
CREATE TABLE "conversation_label" (
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_label_workspace_id_conversation_id_label_id_pk" PRIMARY KEY("workspace_id","conversation_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "label" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" "label_color" DEFAULT 'gray' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "label_name_length" CHECK (char_length("label"."name") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "label_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "label_added" boolean;--> statement-breakpoint
ALTER TABLE "conversation_label" ADD CONSTRAINT "conversation_label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_label" ADD CONSTRAINT "conversation_label_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_label" ADD CONSTRAINT "conversation_label_label_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "public"."label"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_label_label_idx" ON "conversation_label" USING btree ("workspace_id","label_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "label_name_key" ON "label" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_label" CHECK (("webhook_delivery"."label_id" is null) = ("webhook_delivery"."label_added" is null));