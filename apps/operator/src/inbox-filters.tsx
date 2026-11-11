/** @jsxImportSource react */
import type { Assignee, OpenCounts } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { Choices, type Option } from "./ui.tsx";

export type Status = "open" | "closed";
/** Whose conversations the Inbox lists. */
export type Who = "all" | "mine" | "unassigned";

const STATUS_EMPTY: Record<Status, { empty: TextId; hint: TextId }> = {
  open: { empty: "noOpen", hint: "emptyHint" },
  closed: { empty: "noClosed", hint: "closedHint" },
};

const STATUS_OPTIONS: Option<Status>[] = [
  { value: "open", label: "open" },
  { value: "closed", label: "closed" },
];
const WHO_OPTIONS: Option<Who>[] = [
  { value: "all", label: "filterAll" },
  { value: "mine", label: "filterMine" },
  { value: "unassigned", label: "unassigned" },
];
export const WHO_ASSIGNEE: Record<Who, Assignee | null> = {
  all: null,
  mine: "me",
  unassigned: "none",
};

/** What the Inbox lists. */
export type Filter = { status: Status; who: Who };

/** What the Inbox shows, from the address: `?view=closed` and `&who=mine` or `&who=unassigned`. */
export function filterInAddress(): Filter {
  const params = new URLSearchParams(location.search);
  const who = params.get("who");
  return {
    status: params.get("view") === "closed" ? "closed" : "open",
    who: who === "mine" || who === "unassigned" ? who : "all",
  };
}

/** The Inbox's address with this choice, keeping the rest of `from`, such as a conversation. */
export function filterAddress(status: Status, who: Who, from = location.href): string {
  const url = new URL(from);
  if (status === "closed") url.searchParams.set("view", "closed");
  else url.searchParams.delete("view");
  if (who === "all") url.searchParams.delete("who");
  else url.searchParams.set("who", who);
  return `${url.pathname}${url.search}`;
}

/** The empty list's words: a filter's own, or the status's. */
export function emptyLook(status: Status, who: Who): { empty: TextId; hint: TextId | null } {
  if (who === "mine") return { empty: "noMine", hint: null };
  if (who === "unassigned" && status === "open") return { empty: "noUnassigned", hint: null };
  return STATUS_EMPTY[status];
}

/**
 * Open and Closed, and for a team All, Mine and Unassigned under them, each with its count of open
 * conversations. The assignee counts show only on the Open list.
 */
export function ListFilters({
  status,
  who,
  isTeam,
  openBy,
  onChange,
}: {
  status: Status;
  who: Who;
  isTeam: boolean;
  openBy: OpenCounts | null;
  onChange(status: Status, who: Who): void;
}) {
  return (
    <div className="list-filters">
      <Choices
        label={t("listStatus")}
        variant="outlined"
        full
        value={status}
        options={STATUS_OPTIONS.map((option) =>
          option.value === "open" && openBy !== null ? { ...option, count: openBy[who] } : option,
        )}
        onChange={(next) => onChange(next, who)}
      />
      {isTeam && (
        <Choices
          label={t("listAssignee")}
          variant="quiet"
          full
          value={who}
          options={WHO_OPTIONS.map((option) =>
            status === "open" && openBy !== null
              ? { ...option, count: openBy[option.value] }
              : option,
          )}
          onChange={(next) => onChange(status, next)}
        />
      )}
    </div>
  );
}
