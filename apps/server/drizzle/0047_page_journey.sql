CREATE TABLE "page_view" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"visitor_id" uuid NOT NULL,
	"path" text NOT NULL,
	"title" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_view_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "page_view" ADD CONSTRAINT "page_view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_view" ADD CONSTRAINT "page_view_visitor_fk" FOREIGN KEY ("workspace_id","visitor_id") REFERENCES "public"."visitor"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_view_visitor_idx" ON "page_view" USING btree ("workspace_id","visitor_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "page_view_viewed_idx" ON "page_view" USING btree ("viewed_at");--> statement-breakpoint
CREATE INDEX "conversation_created_idx" ON "conversation" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "message_body_trgm_idx" ON "message" USING gin ("body" gin_trgm_ops);