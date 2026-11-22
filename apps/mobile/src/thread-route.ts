export const conversationBackEdge = 44;

/** The conversation pushed over the tabs. `key` names its native screen. */
export type ThreadRoute = { key: string; conversationId: string };

/**
 * Opening the conversation that is already on top keeps its screen, so a double tap or a repeated
 * alert does not push it twice. Any other conversation takes a new key and replaces the screen.
 */
export function openThreadRoute(
  current: ThreadRoute | null,
  conversationId: string,
  serial: number,
): ThreadRoute {
  if (current?.conversationId === conversationId) return current;
  return { key: `thread-${serial}`, conversationId };
}

/**
 * A back swipe or tap closes only the screen it started on. A screen that another conversation
 * already replaced reports its dismissal late, and that report must not close the new one.
 */
export function closeThreadRoute(current: ThreadRoute | null, key: string): ThreadRoute | null {
  return current?.key === key ? null : current;
}
