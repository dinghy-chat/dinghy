ALTER TABLE "outbound_message" DROP CONSTRAINT "outbound_message_status_reason";--> statement-breakpoint
ALTER TABLE "visitor" DROP COLUMN "opted_out_at";--> statement-breakpoint
-- The visitor's opt-out is gone. A message it cancelled reads as cancelled on request, the visitor's.
UPDATE "outbound_message" SET "status_reason" = 'cancelled_by_request' WHERE "status_reason" = 'opted_out';--> statement-breakpoint
-- Nobody is opted out now, so a saved rule on optedOut is always true or always false. It becomes a
-- rule with the same answer for everyone: signedIn exists is always true, signedIn missing never.
CREATE FUNCTION pg_temp.without_opted_out(c jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(c) = 'object' AND c->>'field' = 'optedOut' THEN
    RETURN jsonb_build_object('field', 'signedIn', 'op', CASE
      WHEN c->>'op' = 'exists'
        OR (c->>'op' = 'eq' AND c->'value' = 'false'::jsonb)
        OR (c->>'op' = 'ne' AND c->'value' = 'true'::jsonb) THEN 'exists'
      ELSE 'missing' END);
  ELSIF jsonb_typeof(c) = 'object' THEN
    RETURN (SELECT coalesce(jsonb_object_agg(k, pg_temp.without_opted_out(v)), '{}'::jsonb)
      FROM jsonb_each(c) AS e(k, v));
  ELSIF jsonb_typeof(c) = 'array' THEN
    RETURN (SELECT coalesce(jsonb_agg(pg_temp.without_opted_out(v) ORDER BY i), '[]'::jsonb)
      FROM jsonb_array_elements(c) WITH ORDINALITY AS e(v, i));
  END IF;
  RETURN c;
END $$;--> statement-breakpoint
UPDATE "campaign" SET "definition" = pg_temp.without_opted_out("definition") WHERE "definition"::text LIKE '%"optedOut"%';--> statement-breakpoint
UPDATE "outbound_message" SET "unless" = pg_temp.without_opted_out("unless") WHERE "unless"::text LIKE '%"optedOut"%';--> statement-breakpoint
INSERT INTO "campaign_trigger" ("workspace_id", "campaign_id", "field")
  SELECT "workspace_id", "campaign_id", 'signedIn' FROM "campaign_trigger" WHERE "field" = 'optedOut'
  ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "campaign_trigger" WHERE "field" = 'optedOut';--> statement-breakpoint
UPDATE "visitor" SET "field_times" = "field_times" - 'optedOut' WHERE "field_times" ? 'optedOut';--> statement-breakpoint
DROP FUNCTION pg_temp.without_opted_out(jsonb);--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_status_reason" CHECK ("outbound_message"."status_reason" in ('open_conversation', 'open_conversation_skipped', 'human_handling', 'bots_paused', 'blocked', 'permission_revoked', 'workspace_inactive', 'unless_matched', 'cancelled_by_request', 'conversation_deleted', 'audience_unmatched', 'frequency_capped', 'goal_reached', 'outside_business_hours', 'outside_send_window', 'campaign_paused', 'campaign_ended', 'control_group'));