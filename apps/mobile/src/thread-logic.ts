// Pure rules for the conversation screen: where the message menu opens, the visitor line in the
// header, and how `/` picks a saved reply in the composer. No React Native here, so tests run in Node.

import { plainText } from "../../../packages/widget/src/markdown.ts";
import type { SavedReply } from "./types";

export type Rect = { x: number; y: number; width: number; height: number };

export type MenuPlacement = {
  /** Where the menu's top-left corner goes, in window points. */
  top: number;
  left: number;
  /** Where the lifted copy of the anchor goes. It moves up only when the anchor is too tall. */
  liftTop: number;
  /** The lowest point the lifted copy may reach, so a tall bubble never covers the menu. */
  liftBottom: number;
  above: boolean;
};

const GAP = 8;
const MARGIN = 16;

/**
 * The menu opens 8 pt under the anchor, on the anchor's side. When it does not fit below, it opens
 * above. When it fits neither way, the anchor is taller than the screen allows: the menu sits at
 * the bottom and the lifted copy moves up to end just above it, as if the list had scrolled.
 */
export function menuPlacement(
  anchor: Rect,
  menu: { width: number; height: number },
  screen: { width: number; height: number; top: number; bottom: number },
  side: "start" | "end",
): MenuPlacement {
  const lowest = screen.height - screen.bottom - MARGIN;
  const highest = screen.top + MARGIN;
  const preferred = side === "start" ? anchor.x : anchor.x + anchor.width - menu.width;
  const left = Math.min(Math.max(preferred, MARGIN), screen.width - menu.width - MARGIN);
  const below = anchor.y + anchor.height + GAP;
  if (below + menu.height <= lowest) {
    return {
      top: below,
      left,
      liftTop: anchor.y,
      liftBottom: anchor.y + anchor.height,
      above: false,
    };
  }
  const above = anchor.y - GAP - menu.height;
  if (above >= highest) {
    return {
      top: above,
      left,
      liftTop: anchor.y,
      liftBottom: anchor.y + anchor.height,
      above: true,
    };
  }
  const top = Math.max(highest, lowest - menu.height);
  const liftBottom = top - GAP;
  return { top, left, liftTop: liftBottom - anchor.height, liftBottom, above: false };
}

/** "Portugal" for PT, in the phone's language, or the code when it has no name for it. */
function countryName(country: string): string {
  try {
    return new Intl.DisplayNames([], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

/** "9:41 PM" in the given zone, or null for a zone the phone does not know. */
function clockIn(timeZone: string, now: Date): string | null {
  try {
    return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZone }).format(
      now,
    );
  } catch {
    return null;
  }
}

export function visitorContext(country: string | null, timeZone: string | null, now: Date) {
  return {
    place: country ? countryName(country) : null,
    time: timeZone ? clockIn(timeZone, now) : null,
  };
}

/** A trigger `/` at the start of a line or after a space, and the word typed after it. */
const TYPED_SLASH = /(?:^|\s)\/([^\s/@]*)$/;

export type SlashWord = { from: number; to: number; word: string };

/** The `/word` that ends at the caret, or null. */
export function typedSlash(text: string, caret: number): SlashWord | null {
  const found = TYPED_SLASH.exec(text.slice(0, caret));
  if (!found) return null;
  const word = found[1] ?? "";
  return { from: caret - word.length - 1, to: caret, word };
}

const SHOWN_MAX = 8;

/** The saved replies whose shortcut holds the word, those that start with it first, as on the web. */
export function matchSavedReplies(replies: SavedReply[], word: string): SavedReply[] {
  const typed = word.toLowerCase();
  return replies
    .filter((reply) => reply.shortcut.toLowerCase().includes(typed))
    .sort(
      (a, b) =>
        Number(b.shortcut.toLowerCase().startsWith(typed)) -
        Number(a.shortcut.toLowerCase().startsWith(typed)),
    )
    .slice(0, SHOWN_MAX);
}

/** A saved reply's words on one line, for the list. */
export const savedReplyPreview = (reply: SavedReply) => plainText(reply.body).replace(/\s+/g, " ");

/** A bare link as people read it: no scheme, and no slash at the end of a bare domain. */
export function displayLink(href: string): string {
  return href.replace(/^(https?:\/\/|mailto:)/i, "").replace(/^([^/]+)\/$/, "$1");
}
