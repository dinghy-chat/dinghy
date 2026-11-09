-- Page addresses are at most 2,000 characters. Older servers kept up to 2,048, so shorten those.
UPDATE "visitor" SET "last_page" = left("last_page", 2000) WHERE length("last_page") > 2000;
--> statement-breakpoint
UPDATE "conversation" SET "started_page" = left("started_page", 2000) WHERE length("started_page") > 2000;
