CREATE TABLE "ip_block" (
	"workspace_id" uuid NOT NULL,
	"ip_hash" text NOT NULL,
	"visitor_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_block_workspace_id_ip_hash_visitor_id_pk" PRIMARY KEY("workspace_id","ip_hash","visitor_id")
);
--> statement-breakpoint
CREATE TABLE "storage_deletion" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_deletion_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visitor" ADD COLUMN "last_ip_hash" text;--> statement-breakpoint
ALTER TABLE "ip_block" ADD CONSTRAINT "ip_block_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_block" ADD CONSTRAINT "ip_block_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_block_visitor_idx" ON "ip_block" USING btree ("workspace_id","visitor_id");--> statement-breakpoint
CREATE INDEX "ip_block_expires_idx" ON "ip_block" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "storage_deletion_due_idx" ON "storage_deletion" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "visitor_blocked_idx" ON "visitor" USING btree ("workspace_id") WHERE "visitor"."blocked_at" is not null;