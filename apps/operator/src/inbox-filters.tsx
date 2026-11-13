/** @jsxImportSource react */
import type { Assignee, Label, OpenCounts } from "./api.ts";
import { Icon } from "./icons.tsx";
import { LabelDot } from "./labels.tsx";
import { Popover, Select } from "./popup.tsx";
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

/** The Label choice that lists every conversation. A label's ID is a UUID, so it never clashes. */
const ANY_LABEL = "any";

/** What the Inbox lists: with a label's ID, only the conversations that have it. */
export type Filter = { status: Status; who: Who; label: string | null };

export const sameFilter = (one: Filter, other: Filter) =>
  one.status === other.status && one.who === other.who && one.label === other.label;

/**
 * What the Inbox shows, from the address: `?view=closed`, `&who=mine` or `&who=unassigned`, and
 * `&label=` a label's ID.
 */
export function filterInAddress(): Filter {
  const params = new URLSearchParams(location.search);
  const who = params.get("who");
  return {
    status: params.get("view") === "closed" ? "closed" : "open",
    who: who === "mine" || who === "unassigned" ? who : "all",
    label: params.get("label"),
  };
}

/** The Inbox's address with this choice, keeping the rest of `from`, such as a conversation. */
export function filterAddress({ status, who, label }: Filter, from = location.href): string {
  const url = new URL(from);
  if (status === "closed") url.searchParams.set("view", "closed");
  else url.searchParams.delete("view");
  if (who === "all") url.searchParams.delete("who");
  else url.searchParams.set("who", who);
  if (label === null) url.searchParams.delete("label");
  else url.searchParams.set("label", label);
  return `${url.pathname}${url.search}`;
}

/** The empty list's words: a filter's own, or the status's. */
export function emptyLook({ status, who, label }: Filter): { empty: TextId; hint: TextId | null } {
  if (label !== null) return { empty: "noLabeled", hint: null };
  if (who === "mine") return { empty: "noMine", hint: null };
  if (who === "unassigned" && status === "open") return { empty: "noUnassigned", hint: null };
  return STATUS_EMPTY[status];
}

/**
 * The filter button beside the search, and its card: Open or Closed, for a team All, Mine or
 * Unassigned, each with its count of open conversations, and a label once the team has some. The
 * assignee counts show only on the Open list. A dot on the button says the list is not the default
 * one.
 */
export function ListFilters({
  filter,
  isTeam,
  openBy,
  labels,
  onChange,
}: {
  filter: Filter;
  isTeam: boolean;
  openBy: OpenCounts | null;
  labels: Label[];
  onChange(filter: Filter): void;
}) {
  const { status, who, label } = filter;
  const filtered = status !== "open" || who !== "all" || label !== null;
  return (
    <Popover
      label={t(filtered ? "listFiltered" : "listFilter")}
      title={t("listFilter")}
      buttonClass={filtered ? "filter-button filtered" : "filter-button"}
      buttonContent={<Icon name="filter" size={18} />}
    >
      <p className="popover-label" aria-hidden="true">
        {t("listStatus")}
      </p>
      <Choices
        label={t("listStatus")}
        variant="outlined"
        full
        value={status}
        options={STATUS_OPTIONS.map((option) =>
          option.value === "open" && openBy !== null ? { ...option, count: openBy[who] } : option,
        )}
        onChange={(next) => onChange({ ...filter, status: next })}
      />
      {isTeam && (
        <>
          <p className="popover-label" aria-hidden="true">
            {t("listAssignee")}
          </p>
          <Choices
            label={t("listAssignee")}
            variant="outlined"
            full
            value={who}
            options={WHO_OPTIONS.map((option) =>
              status === "open" && openBy !== null
                ? { ...option, count: openBy[option.value] }
                : option,
            )}
            onChange={(next) => onChange({ ...filter, who: next })}
          />
        </>
      )}
      {(labels.length > 0 || label !== null) && (
        <>
          <p className="popover-label" aria-hidden="true">
            {t("listLabel")}
          </p>
          <Select
            label={t("listLabel")}
            className="wide"
            value={label ?? ANY_LABEL}
            choices={[
              { value: ANY_LABEL, label: t("anyLabel") },
              ...labels.map((one) => ({
                value: one.id,
                label: one.name,
                lead: <LabelDot color={one.color} />,
              })),
            ]}
            onChange={(next) => onChange({ ...filter, label: next === ANY_LABEL ? null : next })}
          />
        </>
      )}
    </Popover>
  );
}
