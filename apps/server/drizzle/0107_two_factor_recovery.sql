CREATE TABLE "two_factor_recovery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completes_at" timestamp with time zone NOT NULL,
	"cancel_token_hash" text NOT NULL,
	"reminded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "two_factor_recovery_cancel_token_hash_unique" UNIQUE("cancel_token_hash"),
	CONSTRAINT "two_factor_recovery_one_end" CHECK ("two_factor_recovery"."cancelled_at" is null or "two_factor_recovery"."completed_at" is null)
);
--> statement-breakpoint
ALTER TABLE "operator" ADD COLUMN "asks_two_factor_again" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor_recovery" ADD CONSTRAINT "two_factor_recovery_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_recovery_waiting_idx" ON "two_factor_recovery" USING btree ("operator_id") WHERE "two_factor_recovery"."cancelled_at" is null and "two_factor_recovery"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "two_factor_recovery_operator_idx" ON "two_factor_recovery" USING btree ("operator_id","cancelled_at");--> statement-breakpoint
CREATE INDEX "two_factor_recovery_due_idx" ON "two_factor_recovery" USING btree ("completes_at") WHERE "two_factor_recovery"."cancelled_at" is null and "two_factor_recovery"."completed_at" is null;