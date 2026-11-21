CREATE TABLE "draft_change_request" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"instruction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"replacement_draft_id" uuid,
	CONSTRAINT "draft_change_request_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "draft_change_request_client_key" UNIQUE("workspace_id","draft_id","client_id"),
	CONSTRAINT "draft_change_request_instruction_length" CHECK (char_length("draft_change_request"."instruction") between 1 and 500),
	CONSTRAINT "draft_change_request_status" CHECK ("draft_change_request"."status" in ('pending', 'fulfilled', 'cancelled')),
	CONSTRAINT "draft_change_request_resolved_at" CHECK (("draft_change_request"."status" = 'pending') = ("draft_change_request"."resolved_at" is null)),
	CONSTRAINT "draft_change_request_replacement" CHECK (("draft_change_request"."status" = 'fulfilled') = ("draft_change_request"."replacement_draft_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "draft_reply" DROP CONSTRAINT "draft_reply_resolved";--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "rewrites_drafts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "change_request_id" uuid;--> statement-breakpoint
ALTER TABLE "draft_change_request" ADD CONSTRAINT "draft_change_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_change_request" ADD CONSTRAINT "draft_change_request_draft_fk" FOREIGN KEY ("workspace_id","draft_id") REFERENCES "public"."draft_reply"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_change_request" ADD CONSTRAINT "draft_change_request_operator_fk" FOREIGN KEY ("workspace_id","operator_id") REFERENCES "public"."workspace_member"("workspace_id","operator_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_change_request" ADD CONSTRAINT "draft_change_request_replacement_fk" FOREIGN KEY ("workspace_id","replacement_draft_id") REFERENCES "public"."draft_reply"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_change_request_pending_key" ON "draft_change_request" USING btree ("workspace_id","draft_id") WHERE "draft_change_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "draft_change_request_replacement_idx" ON "draft_change_request" USING btree ("workspace_id","replacement_draft_id");--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_change_request_fk" FOREIGN KEY ("workspace_id","change_request_id") REFERENCES "public"."draft_change_request"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_change_request_idx" ON "webhook_delivery" USING btree ("workspace_id","change_request_id");--> statement-breakpoint
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_resolved" CHECK ("draft_reply"."resolved" in ('sent', 'discarded', 'replaced'));