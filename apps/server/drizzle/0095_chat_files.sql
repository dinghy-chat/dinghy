ALTER TYPE "public"."message_kind" ADD VALUE 'file' BEFORE 'note';--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "visitor_files" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_image_or_file" CHECK ("attachment"."filename" is null and "attachment"."width" is not null and "attachment"."height" is not null or "attachment"."filename" is not null and "attachment"."width" is null and "attachment"."height" is null);