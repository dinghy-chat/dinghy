CREATE TABLE "shipmail_held_email" (
	"workspace_id" uuid NOT NULL,
	"email_id" text NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipmail_held_email_workspace_id_email_id_pk" PRIMARY KEY("workspace_id","email_id")
);
--> statement-breakpoint
ALTER TABLE "shipmail_held_email" ADD CONSTRAINT "shipmail_held_email_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipmail_held_email_next_try_idx" ON "shipmail_held_email" USING btree ("next_try_at");