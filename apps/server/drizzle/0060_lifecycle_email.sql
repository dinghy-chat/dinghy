CREATE TYPE "public"."lifecycle_email_kind" AS ENUM('ready', 'install', 'team', 'check_in', 'review', 'cancellation', 'ending_soon', 'payment_failed', 'payment_reminder', 'payment_last_day', 'payment_recovered', 'read_only', 'welcome_back', 'deletion_30', 'deletion_7', 'deleted');--> statement-breakpoint
CREATE TABLE "lifecycle_email" (
	"workspace_id" uuid NOT NULL,
	"kind" "lifecycle_email_kind" NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifecycle_email_workspace_id_kind_occurrence_at_pk" PRIMARY KEY("workspace_id","kind","occurrence_at")
);
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD COLUMN "onboarding_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lifecycle_email" ADD CONSTRAINT "lifecycle_email_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_email_due_idx" ON "lifecycle_email" USING btree ("due_at") WHERE "lifecycle_email"."sent_at" is null;