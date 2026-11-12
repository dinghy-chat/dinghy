-- Workspaces from before the Get started steps: a site that started a conversation shows the
-- widget is installed, and settings that differ from the defaults were customized.
UPDATE workspace SET widget_seen_at = created_at
WHERE widget_seen_at IS NULL
  AND EXISTS (
    SELECT 1 FROM conversation
    WHERE conversation.workspace_id = workspace.id AND conversation.started_page IS NOT NULL
  );
--> statement-breakpoint
UPDATE widget_settings SET customized_at = now()
WHERE customized_at IS NULL
  AND (title IS NOT NULL OR greeting IS NOT NULL OR away IS NOT NULL
    OR primary_color IS NOT NULL OR accent_color IS NOT NULL OR position <> 'right'
    OR theme <> 'auto' OR launcher <> 'bubble' OR NOT mascot OR radius <> 16
    OR email_ask <> 'after_first' OR NOT branding);
