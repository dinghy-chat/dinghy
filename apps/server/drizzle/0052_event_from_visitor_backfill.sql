-- Every message.created event says whether the visitor wrote it, so readers need no default. An
-- event whose message is gone counts as an operator's.
UPDATE "event" AS e
SET "payload" = e."payload" || jsonb_build_object(
  'fromVisitor',
  COALESCE(
    (SELECT m."author_visitor_id" IS NOT NULL FROM "message" AS m
     WHERE m."workspace_id" = e."workspace_id" AND m."id"::text = e."payload"->>'messageId'),
    false
  )
)
WHERE e."kind" = 'message.created' AND NOT (e."payload" ? 'fromVisitor');
