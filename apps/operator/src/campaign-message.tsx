/** @jsxImportSource react */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  BUTTON_LABEL_MAX,
  BUTTON_VALUE_MAX,
  BUTTONS_MAX,
  CONTACT_VARIABLES,
  LOCALES,
  type Locale,
  MESSAGE_MAX,
} from "../../../packages/widget/src/shared.ts";
import {
  knownVariable,
  type TemplateProblem,
  templateProblems,
} from "../../../packages/widget/src/template.ts";
import type { CampaignDefinition, CampaignTrigger, Member } from "./api.ts";
import { keyFromName, replaceAt, withPart } from "./campaign-draft.ts";
import { variableWords } from "./campaign-summary.ts";
import { Icon } from "./icons.tsx";
import { Menu, Select } from "./popup.tsx";
import { TemplateText, type TemplateTextHandle } from "./template-text.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Switch } from "./ui.tsx";

export type CampaignMessage = CampaignDefinition["message"];
type Button = NonNullable<CampaignMessage["buttons"]>[number];
type Translation = NonNullable<CampaignMessage["translations"]>[Locale];
/** The message's own text, or one of its translations. */
export type Language = "default" | Locale;

export const LOCALE_TEXT: Record<Locale, TextId> = {
  en: "widgetLanguageEnglish",
  fr: "widgetLanguageFrench",
  es: "widgetLanguageSpanish",
};

/** The message in a language: its translation there, or its own text. */
export function messageIn(message: CampaignMessage, language: Language) {
  const translation = language === "default" ? undefined : message.translations?.[language];
  return {
    body: translation?.body ?? message.body,
    buttons: translation?.buttons ?? message.buttons ?? [],
  };
}

/** The variables one click puts in the text. "Other field" offers the rest. */
const QUICK_VARIABLES: { name: string; label: TextId }[] = [
  { name: "firstName", label: "campaignVariableFirstName" },
  { name: "attributes.plan", label: "campaignVariablePlan" },
];

/** The other variables the text can read, for the campaign's trigger, with an example of each kind. */
function otherVariables(trigger: CampaignTrigger["type"]): string[] {
  const extra =
    trigger === "api" ? ["data.plan"] : trigger === "event" ? ["event.properties.rows"] : [];
  return [...CONTACT_VARIABLES.filter((name) => name !== "firstName"), ...extra];
}

/** A problem with a variable of the text, in words. */
function problemText(problem: TemplateProblem): string {
  switch (problem.kind) {
    case "noVariable":
      return t("templateNoVariable", { tag: problem.tag });
    case "unknownFilter":
      return t("templateUnknownFilter", { filter: problem.filter });
    case "filterArgument":
      return t(problem.takesArgument ? "templateFilterNeedsText" : "templateFilterTakesNoText", {
        filter: problem.filter,
      });
    case "unknownVariable":
      return t("templateUnknownVariable", { path: problem.path });
  }
}

/**
 * The text, with its variables as tokens in words, then `children` (its buttons), then the
 * variables that go in at the caret. A variable that does not read is named under the box.
 */
function BodyField({
  body,
  trigger,
  onChange,
  children,
}: {
  body: string;
  trigger: CampaignTrigger["type"];
  onChange(body: string): void;
  children: ReactNode;
}) {
  const box = useRef<TemplateTextHandle>(null);
  const check = useRef<HTMLTextAreaElement>(null);
  const labelId = useId();
  const problemsId = useId();
  const problems = [
    ...templateProblems(body, knownVariable(trigger)).map(problemText),
    ...(body.length > MESSAGE_MAX
      ? [t("campaignBodyTooLong", { max: MESSAGE_MAX.toLocaleString() })]
      : []),
  ];
  const firstProblem = problems[0] ?? "";
  // The form refuses to save while a variable does not read, as the server would.
  useEffect(() => check.current?.setCustomValidity(firstProblem), [firstProblem]);
  const insert = (name: string) => box.current?.insert(`{{ ${name} }}`);
  return (
    <>
      <span id={labelId} className="visually-hidden">
        {t("campaignBody")}
      </span>
      <div className="composer-text">
        <TemplateText
          ref={box}
          labelId={labelId}
          value={body}
          placeholder={t("campaignBodyPlaceholder")}
          describedBy={problems.length > 0 ? problemsId : undefined}
          wordsOf={variableWords}
          onChange={onChange}
        />
        {/* The form's checks read this copy of the text, which sends its focus to the box. */}
        <textarea
          ref={check}
          className="composer-check"
          tabIndex={-1}
          aria-hidden="true"
          required
          value={body}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => box.current?.focus()}
        />
      </div>
      {children}
      <div className="composer-tools">
        {QUICK_VARIABLES.map((variable) => (
          <button
            key={variable.name}
            type="button"
            className="add-chip"
            onClick={() => insert(variable.name)}
          >
            <Icon name="plus" size={12} />
            {t(variable.label)}
          </button>
        ))}
        <Menu
          label={t("campaignVariableOther")}
          buttonClass="add-chip"
          side="start"
          items={otherVariables(trigger).map((name) => ({
            label: variableWords(name),
            onSelect: () => insert(name),
          }))}
        >
          <Icon name="plus" size={12} />
          {t("campaignVariableOther")}
        </Menu>
      </div>
      {problems.length > 0 && (
        <ul id={problemsId} className="field-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </>
  );
}

type ButtonKind = "answer" | "link" | "dismiss";

const BUTTON_KINDS: { value: ButtonKind; label: TextId }[] = [
  { value: "answer", label: "buttonAnswer" },
  { value: "link", label: "buttonLink" },
  { value: "dismiss", label: "buttonDismiss" },
];

const kindOfButton = (button: Button): ButtonKind =>
  "url" in button ? "link" : "dismiss" in button ? "dismiss" : "answer";

/** A button of a kind, with its words, its value and its page. */
function buttonOf(kind: ButtonKind, label: string, value: string, url: string): Button {
  if (kind === "link") return { label, url, value };
  if (kind === "dismiss") return { label, dismiss: true, value };
  return { label, value };
}

function ButtonRow({
  button,
  onChange,
}: {
  button: Button;
  onChange(button: Button | null): void;
}) {
  const kind = kindOfButton(button);
  const value = button.value ?? "";
  const url = "url" in button ? button.url : "";
  const set = (next: { kind?: ButtonKind; label?: string; value?: string; url?: string }) =>
    onChange(
      buttonOf(next.kind ?? kind, next.label ?? button.label, next.value ?? value, next.url ?? url),
    );
  return (
    <div className="button-row">
      <input
        aria-label={t("buttonLabel")}
        placeholder={t("buttonLabel")}
        required
        maxLength={BUTTON_LABEL_MAX}
        value={button.label}
        onChange={(event) => {
          const label = event.target.value;
          // The value follows the words until someone types their own.
          set(
            value === keyFromName(button.label) ? { label, value: keyFromName(label) } : { label },
          );
        }}
      />
      <Select<ButtonKind>
        label={t("buttonKind")}
        value={kind}
        choices={BUTTON_KINDS.map((one) => ({ value: one.value, label: t(one.label) }))}
        onChange={(next) => set({ kind: next })}
      />
      <input
        aria-label={t("buttonValue")}
        placeholder={t("buttonValue")}
        className="mono"
        required
        maxLength={BUTTON_VALUE_MAX}
        value={value}
        onChange={(event) => set({ value: event.target.value })}
      />
      {kind === "link" && (
        <input
          aria-label={t("buttonUrl")}
          placeholder="https://"
          type="url"
          required
          value={url}
          onChange={(event) => set({ url: event.target.value })}
        />
      )}
      <button
        type="button"
        className="round"
        aria-label={t("buttonRemove")}
        onClick={() => onChange(null)}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/**
 * Up to four buttons as the visitor sees them, each with a value, so results count clicks in every
 * language. A click on one opens its fields under the row.
 */
function ButtonsField({
  buttons,
  onChange,
}: {
  buttons: Button[];
  onChange(buttons: Button[] | undefined): void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const set = (next: Button[]) => onChange(next.length === 0 ? undefined : next);
  const shown = editing === null ? undefined : buttons[editing];
  return (
    <div className="composer-buttons">
      <fieldset className="composer-row">
        <legend className="visually-hidden">{t("campaignButtons")}</legend>
        {buttons.map((button, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a button has no ID, and its place is its name.
            key={index}
            type="button"
            className="answer-pill"
            aria-expanded={editing === index}
            aria-label={t("buttonEdit", { label: button.label || t("buttonLabel") })}
            onClick={() => setEditing(editing === index ? null : index)}
          >
            {button.label || t("buttonLabel")}
          </button>
        ))}
        {buttons.length < BUTTONS_MAX && (
          <button
            type="button"
            className="add-chip"
            onClick={() => {
              set([...buttons, { label: "", value: "" }]);
              setEditing(buttons.length);
            }}
          >
            <Icon name="plus" size={12} />
            {t("buttonAdd")}
          </button>
        )}
      </fieldset>
      {editing !== null && shown !== undefined && (
        <ButtonRow
          button={shown}
          onChange={(next) => {
            set(replaceAt(buttons, editing, next));
            if (next === null) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const SENDER_AUTHOR = "author";
const SENDER_TEAM = "team";

/**
 * Who the visitor sees: the team, a member, or whoever saves the campaign last, which a save here
 * makes you, so it says so.
 */
function SenderField({
  sender,
  members,
  meId,
  onChange,
}: {
  sender: CampaignMessage["sender"];
  members: Member[];
  meId: string | null;
  onChange(sender: CampaignMessage["sender"]): void;
}) {
  const value =
    sender === undefined
      ? SENDER_AUTHOR
      : sender === "team"
        ? SENDER_TEAM
        : "operatorId" in sender
          ? sender.operatorId
          : (members.find((one) => one.email === sender.email)?.id ?? sender.email);
  return (
    <div className="composer-from">
      <span aria-hidden="true">{t("campaignSender")}</span>
      <Select
        label={t("campaignSender")}
        value={value}
        choices={[
          {
            value: SENDER_AUTHOR,
            label: t(members.some((one) => one.id === meId) ? "senderAuthorYou" : "senderAuthor"),
          },
          { value: SENDER_TEAM, label: t("outboundTeam") },
          ...members.map((one) => ({ value: one.id, label: one.name })),
          // An email from code that names no member here, or none yet: kept as it is.
          ...([SENDER_AUTHOR, SENDER_TEAM, ...members.map((one) => one.id)].includes(value)
            ? []
            : [{ value, label: value }]),
        ]}
        onChange={(next) =>
          onChange(
            next === SENDER_AUTHOR
              ? undefined
              : next === SENDER_TEAM
                ? "team"
                : { operatorId: next },
          )
        }
      />
    </div>
  );
}

/** "+ Translation": a menu of the languages that `missing` lists, or nothing when it is empty. */
export function AddTranslation({
  label,
  missing,
  onAdd,
}: {
  label: string;
  missing: Locale[];
  onAdd(locale: Locale): void;
}) {
  if (missing.length === 0) return null;
  return (
    <Menu
      label={label}
      buttonClass="text-button"
      items={missing.map((locale) => ({
        label: t(LOCALE_TEXT[locale]),
        onSelect: () => onAdd(locale),
      }))}
    >
      <Icon name="plus" size={14} />
      {t("campaignAddTranslation")}
    </Menu>
  );
}

/** The languages the message has, as a small segmented control, once it has a translation. */
function LanguageTabs({
  message,
  language,
  onLanguage,
}: {
  message: CampaignMessage;
  language: Language;
  onLanguage(language: Language): void;
}) {
  const translated = LOCALES.filter((one) => message.translations?.[one] !== undefined);
  if (translated.length === 0) return null;
  return (
    <Choices<Language>
      label={t("campaignLanguages")}
      variant="outlined"
      value={language}
      options={[
        { value: "default", label: "campaignDefaultLanguage" },
        ...translated.map((one) => ({ value: one, label: LOCALE_TEXT[one] })),
      ]}
      onChange={onLanguage}
    />
  );
}

/** A translation's text, and its own buttons or the message's. */
function TranslationFields({
  locale,
  message,
  trigger,
  onChange,
  onRemoved,
}: {
  locale: Locale;
  message: CampaignMessage;
  trigger: CampaignTrigger["type"];
  onChange(message: CampaignMessage): void;
  onRemoved(): void;
}) {
  const translation = message.translations?.[locale] ?? { body: message.body };
  const set = (next: Translation | undefined) => {
    const { [locale]: _old, ...others } = message.translations ?? {};
    const translations = next === undefined ? others : { ...others, [locale]: next };
    onChange(
      withPart(
        message,
        "translations",
        Object.keys(translations).length === 0 ? undefined : translations,
      ),
    );
  };
  return (
    <>
      <BodyField
        body={translation.body}
        trigger={trigger}
        onChange={(body) => set({ ...translation, body })}
      >
        {translation.buttons !== undefined && (
          <ButtonsField
            buttons={translation.buttons}
            onChange={(buttons) => set(withPart(translation, "buttons", buttons ?? []))}
          />
        )}
      </BodyField>
      <div className="composer-foot">
        <Switch
          label={t("translationButtons")}
          hint={t("translationButtonsHelp")}
          checked={translation.buttons !== undefined}
          onChange={(own) =>
            set(withPart(translation, "buttons", own ? (message.buttons ?? []) : undefined))
          }
        />
        <button
          type="button"
          className="text-button"
          onClick={() => {
            set(undefined);
            onRemoved();
          }}
        >
          {t("campaignRemoveLanguage", { language: t(LOCALE_TEXT[locale]) })}
        </button>
      </div>
    </>
  );
}

/** The composer: who sends the message, its text with variables, its buttons and its languages. */
export function MessageFields({
  message,
  trigger,
  members,
  meId,
  language,
  onLanguage,
  onChange,
}: {
  message: CampaignMessage;
  trigger: CampaignTrigger["type"];
  members: Member[];
  meId: string | null;
  /** The language on show, which the preview shows too. */
  language: Language;
  onLanguage(language: Language): void;
  onChange(message: CampaignMessage): void;
}) {
  // A variant may lack the language that the campaign's own message has.
  const shown = language !== "default" && message.translations?.[language] ? language : "default";
  return (
    <div className="composer">
      <div className="composer-head">
        <SenderField
          sender={message.sender}
          members={members}
          meId={meId}
          onChange={(sender) => onChange(withPart(message, "sender", sender))}
        />
        <LanguageTabs message={message} language={shown} onLanguage={onLanguage} />
      </div>
      {message.translations !== undefined && (
        <p className="hint composer-hint">{t("campaignLanguagesHelp")}</p>
      )}
      {shown === "default" ? (
        <BodyField
          body={message.body}
          trigger={trigger}
          onChange={(body) => onChange({ ...message, body })}
        >
          <ButtonsField
            buttons={message.buttons ?? []}
            onChange={(buttons) => onChange(withPart(message, "buttons", buttons))}
          />
        </BodyField>
      ) : (
        <TranslationFields
          key={shown}
          locale={shown}
          message={message}
          trigger={trigger}
          onChange={onChange}
          onRemoved={() => onLanguage("default")}
        />
      )}
    </div>
  );
}
