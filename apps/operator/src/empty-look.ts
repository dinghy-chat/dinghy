// Which empty state the Inbox shows, from what it has already loaded. No art here, so it is easy
// to test.

/** What the list shows now. */
export type ListShows = "loading" | "rows" | "empty" | "searchEmpty";

/** The two get-started steps that tell a new workspace from a quiet one. */
export interface FirstSteps {
  /** An allowed site loaded the widget. */
  install: boolean;
  /** A real conversation, not a test visitor's or the cloud's welcome chat, ever took place. */
  chat: boolean;
}

/**
 * The pane beside the list with no conversation open:
 * - `pick`: the list has rows (A).
 * - `caughtUp`: the inbox is empty, and the workspace has had conversations (B).
 * - `noMatch`: a search or a filter found nothing (C).
 * - `board`: a new workspace whose widget is not installed, where the owner can send a test (D).
 * - `waitingSetup`: the same for a member who may not send a test.
 * - `live`: the widget is installed, and no conversation came yet (E).
 * - `loading`: not known yet, so nothing shows.
 */
export type PaneLook =
  | { kind: "pick" }
  | { kind: "caughtUp" }
  | { kind: "noMatch"; by: "search" | "filter" }
  | { kind: "board" }
  | { kind: "waitingSetup" }
  | { kind: "live" }
  | { kind: "loading" };

export function chooseLook({
  shows,
  isFiltered,
  steps,
  maySetUp,
}: {
  shows: ListShows;
  /** The list shows less than every open conversation, as with Closed, Mine or a label. */
  isFiltered: boolean;
  steps: FirstSteps | null;
  /** An owner or admin, who may send a test message. */
  maySetUp: boolean;
}): PaneLook {
  if (shows === "rows") return { kind: "pick" };
  if (shows === "searchEmpty") return { kind: "noMatch", by: "search" };
  if (shows === "loading") return { kind: "loading" };
  if (isFiltered) return { kind: "noMatch", by: "filter" };
  if (steps === null) return { kind: "loading" };
  if (steps.chat) return { kind: "caughtUp" };
  if (steps.install) return { kind: "live" };
  return { kind: maySetUp ? "board" : "waitingSetup" };
}

const EMPTY_INBOX = ["caughtUp", "board", "waitingSetup", "live"] as const;
type EmptyInbox = Extract<PaneLook, { kind: (typeof EMPTY_INBOX)[number] }>;

/** The looks of an empty inbox, where the first conversation's arrival gets a flight. */
export const isEmptyInbox = (look: PaneLook): look is EmptyInbox =>
  EMPTY_INBOX.some((kind) => kind === look.kind);
