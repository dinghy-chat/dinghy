CREATE TYPE "public"."widget_email_ask" AS ENUM('off', 'after_first', 'before_first');--> statement-breakpoint
CREATE TYPE "public"."widget_launcher" AS ENUM('boat', 'bubble', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."widget_position" AS ENUM('left', 'right');--> statement-breakpoint
CREATE TYPE "public"."widget_theme" AS ENUM('light', 'dark', 'auto');--> statement-breakpoint
CREATE TABLE "operator_picture" (
	"operator_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"title" text,
	"greeting" text,
	"away" text,
	"logo_updated_at" timestamp with time zone,
	"primary_color" text,
	"accent_color" text,
	"position" "widget_position" DEFAULT 'right' NOT NULL,
	"theme" "widget_theme" DEFAULT 'auto' NOT NULL,
	"launcher" "widget_launcher" DEFAULT 'boat' NOT NULL,
	"mascot" boolean DEFAULT true NOT NULL,
	"radius" smallint DEFAULT 16 NOT NULL,
	"email_ask" "widget_email_ask" DEFAULT 'after_first' NOT NULL,
	"branding" boolean DEFAULT true NOT NULL,
	CONSTRAINT "widget_settings_primary_color" CHECK ("widget_settings"."primary_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "widget_settings_accent_color" CHECK ("widget_settings"."accent_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "widget_settings_radius" CHECK ("widget_settings"."radius" between 0 and 24)
);
--> statement-breakpoint
ALTER TABLE "operator" ADD COLUMN "picture_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_picture" ADD CONSTRAINT "operator_picture_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD CONSTRAINT "widget_settings_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_operator_seq_idx" ON "message" USING btree ("workspace_id","author_operator_id","seq") WHERE "message"."author_operator_id" is not null;--> statement-breakpoint
-- Every workspace gets its row, with the texts and the logo's time it had, before they go.
INSERT INTO "widget_settings" ("workspace_id", "title", "greeting", "away", "logo_updated_at")
SELECT w."id", w."widget_title", w."widget_greeting", w."widget_away", l."updated_at"
FROM "workspace" AS w
LEFT JOIN "workspace_logo" AS l ON l."workspace_id" = w."id";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "widget_title";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "widget_greeting";--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "widget_away";--> statement-breakpoint
ALTER TABLE "workspace_logo" DROP COLUMN "updated_at";