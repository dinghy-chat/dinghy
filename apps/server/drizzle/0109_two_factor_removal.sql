ALTER TABLE "two_factor_recovery" RENAME TO "two_factor_removal";--> statement-breakpoint
ALTER TABLE "two_factor_removal" DROP CONSTRAINT "two_factor_recovery_cancel_token_hash_unique";--> statement-breakpoint
ALTER TABLE "two_factor_removal" DROP CONSTRAINT "two_factor_recovery_one_end";--> statement-breakpoint
ALTER TABLE "two_factor_removal" DROP CONSTRAINT "two_factor_recovery_operator_id_operator_id_fk";
--> statement-breakpoint
DROP INDEX "two_factor_recovery_waiting_idx";--> statement-breakpoint
DROP INDEX "two_factor_recovery_operator_idx";--> statement-breakpoint
DROP INDEX "two_factor_recovery_due_idx";--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD COLUMN "warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD COLUMN "next_warning_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD COLUMN "warning_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD CONSTRAINT "two_factor_removal_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_removal_waiting_idx" ON "two_factor_removal" USING btree ("operator_id") WHERE "two_factor_removal"."cancelled_at" is null and "two_factor_removal"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "two_factor_removal_operator_idx" ON "two_factor_removal" USING btree ("operator_id","cancelled_at");--> statement-breakpoint
CREATE INDEX "two_factor_removal_due_idx" ON "two_factor_removal" USING btree ("completes_at") WHERE "two_factor_removal"."cancelled_at" is null and "two_factor_removal"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "two_factor_removal_warning_idx" ON "two_factor_removal" USING btree ("next_warning_at") WHERE "two_factor_removal"."cancelled_at" is null and "two_factor_removal"."completed_at" is null;--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD CONSTRAINT "two_factor_removal_cancel_token_hash_unique" UNIQUE("cancel_token_hash");--> statement-breakpoint
ALTER TABLE "two_factor_removal" ADD CONSTRAINT "two_factor_removal_one_end" CHECK ("two_factor_removal"."cancelled_at" is null or "two_factor_removal"."completed_at" is null);