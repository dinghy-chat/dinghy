CREATE TABLE "native_push_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_push_device_provider_token_key" UNIQUE("provider","token"),
	CONSTRAINT "native_push_device_provider" CHECK ("native_push_device"."provider" in ('apns', 'fcm'))
);
--> statement-breakpoint
ALTER TABLE "native_push_device" ADD CONSTRAINT "native_push_device_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_push_device" ADD CONSTRAINT "native_push_device_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_push_device_operator_idx" ON "native_push_device" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "native_push_device_session_idx" ON "native_push_device" USING btree ("session_id");