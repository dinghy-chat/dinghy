-- A webhook's conversation names its handler: the key that took part last, by a message, a note or a
-- draft. The worker builds that payload, so it reads drafts too, under the tenant policy.
GRANT SELECT ON draft_reply TO dinghy_worker;
--> statement-breakpoint
-- The event `conversation.bot_resumed` is now `conversation.given_back`. Only builds before a
-- release could store the old name.
UPDATE webhook SET events = array_replace(events, 'conversation.bot_resumed', 'conversation.given_back')
  WHERE 'conversation.bot_resumed' = ANY(events);
--> statement-breakpoint
UPDATE webhook_delivery SET type = 'conversation.given_back' WHERE type = 'conversation.bot_resumed';
