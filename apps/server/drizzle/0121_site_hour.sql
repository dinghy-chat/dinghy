CREATE TABLE "site_hour" (
	"workspace_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"visits" integer NOT NULL,
	"page_views" integer NOT NULL,
	"peak" integer NOT NULL,
	"peak_at" timestamp with time zone,
	"pages" jsonb NOT NULL,
	"referrers" jsonb NOT NULL,
	"titles" jsonb NOT NULL,
	CONSTRAINT "site_hour_workspace_id_hour_pk" PRIMARY KEY("workspace_id","hour")
);
--> statement-breakpoint
ALTER TABLE "site_hour" ADD CONSTRAINT "site_hour_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_hour_hour_idx" ON "site_hour" USING btree ("hour");