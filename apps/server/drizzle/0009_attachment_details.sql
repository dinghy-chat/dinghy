ALTER TABLE "attachment" ADD COLUMN "content_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "width" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "height" integer NOT NULL;