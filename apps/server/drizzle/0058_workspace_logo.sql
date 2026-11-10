CREATE TABLE "workspace_logo" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"content_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_logo" ADD CONSTRAINT "workspace_logo_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;