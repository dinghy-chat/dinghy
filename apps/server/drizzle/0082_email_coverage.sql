ALTER TABLE "alert_delivery" ADD COLUMN "covered_from_seq" bigint;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "covered_to_seq" bigint;--> statement-breakpoint
CREATE INDEX "message_changed_idx" ON "message" USING btree ("workspace_id","changed_seq") WHERE "message"."changed_seq" is not null;--> statement-breakpoint
-- Emails sent before this release recorded no range. A reply email carried up to 5 of the newest
-- unread replies when it went, which can include replies written after the one that queued it. So
-- its range is every team reply the visitor had when it finished: too wide on purpose, because a
-- range that is too wide only marks a few old replies as emailed and keeps them from being edited,
-- while one that is too narrow would let an operator change a reply the visitor already got.
-- Each lookup reads one conversation's messages newest first through message_conversation_idx and
-- stops at the first match, so the upgrade does not scan whole histories.
UPDATE "alert_delivery" AS d SET "covered_from_seq" = 0, "covered_to_seq" = coalesce((
  SELECT max(newest."seq") FROM "conversation" AS c
  CROSS JOIN LATERAL (
    SELECT m."seq" FROM "message" AS m
    WHERE m."workspace_id" = c."workspace_id" AND m."conversation_id" = c."id"
      AND m."author_visitor_id" IS NULL AND m."kind"::text IN ('text', 'image')
      AND m."created_at" <= d."finished_at"
    ORDER BY m."seq" DESC LIMIT 1
  ) AS newest
  WHERE c."workspace_id" = d."workspace_id" AND c."visitor_id" = d."visitor_id"
), d."event_seq")
WHERE d."channel" = 'email' AND d."visitor_id" IS NOT NULL AND d."outcome" = 'sent';--> statement-breakpoint
-- A transcript carried every message of its conversation when it went, including ones written
-- after the event that queued it. As text, because an upgrade from before 0078 adds 'transcript'
-- in this same transaction, and Postgres refuses a new enum value there.
UPDATE "alert_delivery" AS d SET "covered_from_seq" = 0, "covered_to_seq" = greatest(d."event_seq", coalesce((
  SELECT m."seq" FROM "message" AS m
  WHERE m."workspace_id" = d."workspace_id" AND m."conversation_id" = d."conversation_id"
    AND m."created_at" <= d."finished_at"
  ORDER BY m."seq" DESC LIMIT 1
), d."event_seq"))
WHERE d."channel"::text = 'transcript' AND d."outcome" = 'sent';
