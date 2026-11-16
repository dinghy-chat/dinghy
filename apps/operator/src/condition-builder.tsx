/** @jsxImportSource react */
import { useState } from "react";
import type { Condition } from "./api.ts";
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
import { Icon } from "./icons.tsx";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";

const FIELD_TEXT: Record<FieldChoice, TextId> = {
  name: "conditionFieldName",
  firstName: "conditionFieldFirstName",
  email: "email",
  userId: "conditionFieldUserId",
  language: "conditionFieldLanguage",
  country: "colCountry",
  timeZone: "conditionFieldTimeZone",
  signedIn: "conditionFieldSignedIn",
  hasChatted: "conditionFieldHasChatted",
  optedOut: "conditionFieldOptedOut",
  conversationCount: "colConversations",
  firstSeenAt: "sortFirstSeen",
  lastSeenAt: "sortLastSeen",
  attribute: "conditionFieldAttribute",
  eventCount: "conditionFieldEventCount",
  eventLastAt: "conditionFieldEventLastAt",
  repliedToCampaign: "conditionFieldReplied",
};

const OP_TEXT: Record<Op, TextId> = {
  eq: "conditionIs",
  ne: "conditionIsNot",
  in: "conditionIn",
  not_in: "conditionNotIn",
  exists: "conditionExists",
  missing: "conditionMissing",
  gt: "conditionGt",
  gte: "conditionGte",
  lt: "conditionLt",
  lte: "conditionLte",
  contains: "conditionContains",
  older_than: "conditionOlderThan",
};

/** A time compares as before and after, not as more and less. */
const TIME_OP_TEXT: Partial<Record<Op, TextId>> = {
  gt: "conditionAfter",
  gte: "conditionAfter",
  lt: "conditionBefore",
  lte: "conditionBefore",
};

const MATCHES: { value: GroupMatch; label: TextId }[] = [
  { value: "all", label: "conditionMatchAll" },
  { value: "any", label: "conditionMatchAny" },
  { value: "none", label: "conditionMatchNone" },
];

const opText = (rule: RuleDraft, op: Op) =>
  t((kindOf(rule.field) === "time" ? TIME_OP_TEXT[op] : undefined) ?? OP_TEXT[op]);

/** The box for a rule's value, by its field's kind and its operator. */
function ValueInput({ rule, onChange }: { rule: RuleDraft; onChange(text: string): void }) {
  const kind = kindOf(rule.field);
  const label = t("conditionValue");
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
  const type = takesList(rule.op)
    ? "text"
    : kind === "number"
      ? "number"
      : kind === "time" && rule.op !== "older_than"
        ? "datetime-local"
        : "text";
  const placeholder = takesList(rule.op)
    ? t("conditionListPlaceholder")
    : rule.op === "older_than"
      ? t("durationPlaceholder")
      : undefined;
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
        choices={opsFor(rule).map((op) => ({ value: op, label: opText(rule, op) }))}
        onChange={(op) => onChange({ ...rule, op })}
      />
      {takesValue(rule.op) && (
        <ValueInput rule={rule} onChange={(text) => onChange({ ...rule, text })} />
      )}
      <button type="button" className="round" aria-label={t("conditionRemove")} onClick={onRemove}>
        <Icon name="close" size={16} />
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
      group.items.flatMap((item) => (item.id !== id ? [item] : next === null ? [] : [next])),
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
          {t("conditionAddRule")}
        </button>
        {!nested && (
          <button type="button" className="text-button" onClick={() => add(newGroup([newRule()]))}>
            {t("conditionAddGroup")}
          </button>
        )}
        {quickRule !== null && (
          <button type="button" className="text-button" onClick={() => add(newRule(quickRule))}>
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
