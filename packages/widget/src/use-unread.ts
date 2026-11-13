import { useEffect, useState } from "preact/hooks";
import type { Client } from "./client.ts";
import { reportUnread } from "./page-events.ts";
import type { Line } from "./panel.tsx";
import type { SavedAppearance, WidgetContext } from "./shared.ts";
import { t } from "./text.ts";

/** The launcher's count, in its badge and its label. The full-page chat has no launcher. */
function drawBadge(shadow: ShadowRoot, count: number) {
  const launcher = shadow.querySelector(".launcher");
  if (launcher === null) return;
  let badge = launcher.querySelector<HTMLElement>(".badge");
  if (badge === null) {
    badge = document.createElement("span");
    badge.className = "badge";
    launcher.append(badge);
  }
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  launcher.setAttribute("aria-label", count ? `${t("launcher")} (${count})` : t("launcher"));
}

/** Math.max does not accept a bigint. */
export const larger = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * How many replies the visitor has not read, for the page's `unread` event and the launcher's
 * badge, and the read position, which moves when the visitor can see what the stream delivered.
 * Before the stream replays history, the server's count is the only one, and with no stream, as
 * after an operator closes the conversation, the lines can be behind too.
 */
export function useUnread(
  context: WidgetContext,
  client: Client,
  token: string | null,
  lines: Line[],
  /** The lines hold every reply: the history has arrived and a stream keeps them. */
  counting: boolean,
  /** The visitor can see the chat now. */
  seeing: boolean,
  /** The newest position the stream has delivered. */
  delivered: bigint,
  saved: SavedAppearance | undefined,
) {
  const [lastRead, setLastRead] = useState(0n);
  // The server's count, with the read position it was computed from.
  const [serverRead, setServerRead] = useState({ unread: 0, position: 0n });
  const unread = counting
    ? lines.filter(
        (line) =>
          !line.fromVisitor && !line.note && !line.gone && line.seq !== null && line.seq > lastRead,
      ).length
    : lastRead > serverRead.position
      ? 0
      : serverRead.unread;
  useEffect(() => reportUnread(context, unread), [context, unread]);
  // After the saved look arrives, because the loader draws the launcher only then, and a returning
  // visitor's count can come first.
  useEffect(() => {
    if (saved !== undefined) drawBadge(context.shadow, unread);
  }, [context, saved, unread]);

  // A message counts as read only when the visitor can see it.
  useEffect(() => {
    if (!seeing || token === null || delivered <= lastRead) return;
    setLastRead(delivered);
    client.markRead(token, delivered.toString()).catch(() => {
      // The count returns on the next page load, and a later read moves the position past it.
    });
  }, [client, delivered, lastRead, seeing, token]);

  /** The server's count, and the read position it was computed from. */
  return (count: number, position: bigint) => {
    // The larger one, because this response can be older than a read in this tab.
    setLastRead((current) => larger(current, position));
    setServerRead({ unread: count, position });
  };
}
