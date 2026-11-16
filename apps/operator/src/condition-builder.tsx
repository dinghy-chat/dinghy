/** @jsxImportSource react */
import { useState } from "react";
import type { Condition, WorkspaceApi } from "./api.ts";
import {
  conditionOf,
  FIELD_CHOICES,
  type FieldChoice,
  type GroupDraft,
  type GroupMatch,
  groupOf,
  isGroup,
  kindOf,
  newGroup,
  newRule,
  type Op,
  opsFor,
  type RuleDraft,
  takesKey,
  takesList,
  takesValue,
} from "./campaign-conditions.ts";
import { replaceAt } from "./campaign-draft.ts";
import { FIELD_TEXT, opText } from "./campaign-summary.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";

const MATCHES: { value: GroupMatch; label: TextId }[] = [
  { value: "all", label: "conditionMatchAll" },
  { value: "any", label: "conditionMatchAny" },
  { value: "none", label: "conditionMatchNone" },
];

/** The words of the button that adds a rule, by how the group joins its rules. */
const ADD_TEXT: Record<GroupMatch, TextId> = {
  all: "conditionAndRule",
  any: "conditionOrRule",
  none: "conditionAddRule",
};

/** A list's values as typed, each once. */
const valuesOf = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== ""),
  ),
];

/** A list's values as tokens, each removed with its ×, and a box that adds one on Enter or a comma. */
function ValueTokens({ text, onChange }: { text: string; onChange(text: string): void }) {
  const [typed, setTyped] = useState("");
  const values = valuesOf(text);
  const add = () => {
    if (typed.trim() !== "") onChange([...values, ...valuesOf(typed)].join(", "));
    setTyped("");
  };
  return (
    <>
      {values.map((value) => (
        <span key={value} className="value-token">
          {value}
          <button
            type="button"
            className="token-remove"
            aria-label={t("conditionRemoveValue", { value })}
            onClick={() => onChange(values.filter((one) => one !== value).join(", "))}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <input
        className="value-add"
        aria-label={t("conditionValue")}
        placeholder={t("conditionAddValue")}
        value={typed}
        // A list with no value matches nobody, so the form asks for one.
        required={values.length === 0}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== ",") return;
          event.preventDefault();
          add();
        }}
      />
    </>
  );
}

/** The box for a rule's value, by its field's kind and its operator. */
function ValueInput({ rule, onChange }: { rule: RuleDraft; onChange(text: string): void }) {
  const kind = kindOf(rule.field);
  const label = t("conditionValue");
  if (takesList(rule.op)) return <ValueTokens text={rule.text} onChange={onChange} />;
  if (kind === "boolean") {
    return (
      <Select
        label={label}
        value={rule.text === "false" ? "false" : "true"}
        choices={[
          { value: "true", label: t("conditionYes") },
          { value: "false", label: t("conditionNo") },
        ]}
        onChange={onChange}
      />
    );
  }
  const type =
    kind === "number"
      ? "number"
      : kind === "time" && rule.op !== "older_than"
        ? "datetime-local"
        : "text";
  const placeholder = rule.op === "older_than" ? t("durationPlaceholder") : undefined;
  return (
    <input
      aria-label={label}
      type={type}
      value={rule.text}
      placeholder={placeholder}
      required
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** The IDs of the lists of names that `NameLists` suggests as a rule's key is typed. */
const ATTRIBUTE_NAMES = "attribute-names";
export const EVENT_NAMES = "event-names";

/**
 * The attribute keys and event names of recent contacts, as lists a key field suggests from. A new
 * name can still be typed, for an attribute or an event no contact has yet.
 */
export function NameLists({ api }: { api: WorkspaceApi }) {
  const names = useLoad(() => api.campaignNames(), [api]).data;
  return (
    <>
      <datalist id={ATTRIBUTE_NAMES}>
        {names?.attributes.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id={EVENT_NAMES}>
        {names?.events.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

function RuleRow({
  rule,
  fields,
  onChange,
  onRemove,
}: {
  rule: RuleDraft;
  fields: FieldChoice[];
  onChange(rule: RuleDraft): void;
  onRemove(): void;
}) {
  return (
    <li className="condition-rule">
      <Select<FieldChoice>
        label={t("conditionField")}
        value={rule.field}
        choices={fields.map((field) => ({ value: field, label: t(FIELD_TEXT[field]) }))}
        onChange={(field) => onChange({ ...newRule(field), id: rule.id, key: rule.key })}
      />
      {takesKey(rule.field) && (
        <input
          list={rule.field === "attribute" ? ATTRIBUTE_NAMES : EVENT_NAMES}
          aria-label={t(
            rule.field === "attribute" ? "conditionAttributeKey" : "conditionEventName",
          )}
          placeholder={t(
            rule.field === "attribute" ? "conditionAttributeKey" : "conditionEventName",
          )}
          value={rule.key}
          required
          onChange={(event) => onChange({ ...rule, key: event.target.value })}
        />
      )}
      <Select<Op>
        label={t("conditionOp")}
        value={rule.op}
        choices={opsFor(rule).map((op) => ({ value: op, label: opText(rule.field, op) }))}
        onChange={(op) => onChange({ ...rule, op })}
      />
      {takesValue(rule.op) && (
        <ValueInput rule={rule} onChange={(text) => onChange({ ...rule, text })} />
      )}
      <button
        type="button"
        className="condition-remove"
        aria-label={t("conditionRemove")}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}

function GroupBox({
  group,
  fields,
  nested,
  quickRule,
  emptyText,
  onChange,
  onRemove,
}: {
  group: GroupDraft;
  fields: FieldChoice[];
  /** A group inside another: it has a remove button, and holds no more groups. */
  nested: boolean;
  /** A field one click adds, with its yes, such as "Replied to this campaign". */
  quickRule: FieldChoice | null;
  emptyText: TextId;
  onChange(group: GroupDraft): void;
  onRemove?: () => void;
}) {
  const setItems = (items: GroupDraft["items"]) => onChange({ ...group, items });
  const replace = (id: number, next: RuleDraft | GroupDraft | null) =>
    setItems(
      replaceAt(
        group.items,
        group.items.findIndex((item) => item.id === id),
        next,
      ),
    );
  const add = (item: RuleDraft | GroupDraft) => setItems([...group.items, item]);
  return (
    <div className={nested ? "condition-group nested" : "condition-group"}>
      {group.items.length === 0 ? (
        <p className="hint">{t(emptyText)}</p>
      ) : (
        <div className="condition-match">
          <Select<GroupMatch>
            label={t("conditionMatch")}
            value={group.match}
            choices={MATCHES.map((one) => ({ value: one.value, label: t(one.label) }))}
            onChange={(match) => onChange({ ...group, match })}
          />
          {onRemove !== undefined && (
            <button type="button" className="text-button" onClick={onRemove}>
              {t("conditionRemoveGroup")}
            </button>
          )}
        </div>
      )}
      <ul className="condition-items">
        {group.items.map((item) =>
          isGroup(item) ? (
            <li key={item.id}>
              <GroupBox
                group={item}
                fields={fields}
                nested
                quickRule={null}
                emptyText="conditionGroupEmpty"
                onChange={(next) => replace(item.id, next)}
                onRemove={() => replace(item.id, null)}
              />
            </li>
          ) : (
            <RuleRow
              key={item.id}
              rule={item}
              fields={fields}
              onChange={(next) => replace(item.id, next)}
              onRemove={() => replace(item.id, null)}
            />
          ),
        )}
      </ul>
      <div className="condition-adds">
        <button type="button" className="text-button" onClick={() => add(newRule())}>
          <Icon name="plus" size={14} />
          {t(group.items.length === 0 ? "conditionAddRule" : ADD_TEXT[group.match])}
        </button>
        {!nested && (
          <button type="button" className="text-button" onClick={() => add(newGroup([newRule()]))}>
            <Icon name="plus" size={14} />
            {t("conditionAddGroup")}
          </button>
        )}
        {quickRule !== null && (
          <button type="button" className="text-button" onClick={() => add(newRule(quickRule))}>
            <Icon name="plus" size={14} />
            {t("conditionAddQuick", { field: t(FIELD_TEXT[quickRule]) })}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Rules on a contact, in groups that match all, any or none of their rules. It keeps what was typed
 * and gives the condition it makes on each change, or undefined with no rule. In a campaign's own
 * conditions, "Replied to this campaign" is one click away.
 */
export function ConditionBuilder({
  initial,
  inCampaign = false,
  emptyText,
  onChange,
}: {
  /** The condition it starts from. Later changes come from the builder alone. */
  initial: Condition | undefined;
  inCampaign?: boolean;
  emptyText: TextId;
  onChange(condition: Condition | undefined): void;
}) {
  const [root, setRoot] = useState(() => groupOf(initial));
  const fields = FIELD_CHOICES.filter((field) => inCampaign || field !== "repliedToCampaign");
  return (
    <GroupBox
      group={root}
      fields={fields}
      nested={false}
      quickRule={inCampaign ? "repliedToCampaign" : null}
      emptyText={emptyText}
      onChange={(next) => {
        setRoot(next);
        onChange(conditionOf(next));
      }}
    />
  );
}
