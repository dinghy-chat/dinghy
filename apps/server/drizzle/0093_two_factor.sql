CREATE TABLE "operator_two_factor" (
	"operator_id" uuid PRIMARY KEY NOT NULL,
	"secret" "bytea" NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_step" bigint,
	"recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "two_factor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_two_factor" ADD CONSTRAINT "operator_two_factor_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;