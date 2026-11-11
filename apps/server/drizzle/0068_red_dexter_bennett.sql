ALTER TYPE "public"."widget_launcher" ADD VALUE 'label';--> statement-breakpoint
ALTER TYPE "public"."widget_launcher" ADD VALUE 'square';--> statement-breakpoint
ALTER TABLE "widget_settings" ALTER COLUMN "launcher" SET DEFAULT 'bubble';