// The events the host page listens to, through Dinghy.on().

import type { DinghyEvent, DinghyEvents, WidgetContext } from "./shared.ts";

/** Calls the page's callbacks. One that throws is reported, and the others still run. */
export function emit<E extends DinghyEvent>(
  context: WidgetContext,
  event: E,
  data: DinghyEvents[E],
) {
  for (const callback of context.listeners[event] ?? []) {
    try {
      callback(data);
    } catch (error) {
      reportError(error);
    }
  }
}

/** The page's `unread` event, once for each new count. */
export function reportUnread(context: WidgetContext, count: number) {
  if (count === context.state.unread) return;
  context.state.unread = count;
  emit(context, "unread", count);
}

/** The page's `conversation` event, once for each change. */
export function reportConversation(context: WidgetContext, open: boolean) {
  if (open === context.state.conversation) return;
  context.state.conversation = open;
  emit(context, "conversation", open);
}
