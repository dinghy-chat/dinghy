CREATE TABLE "welcome_link" (
	"customer_workspace_id" uuid NOT NULL,
	"customer_conversation_id" uuid NOT NULL,
	"founder_workspace_id" uuid NOT NULL,
	"founder_conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "welcome_link_customer_workspace_id_customer_conversation_id_pk" PRIMARY KEY("customer_workspace_id","customer_conversation_id"),
	CONSTRAINT "welcome_link_founder_key" UNIQUE("founder_workspace_id","founder_conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "welcome" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "welcome_link" ADD CONSTRAINT "welcome_link_customer_fk" FOREIGN KEY ("customer_workspace_id","customer_conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_link" ADD CONSTRAINT "welcome_link_founder_fk" FOREIGN KEY ("founder_workspace_id","founder_conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE cascade ON UPDATE no action;