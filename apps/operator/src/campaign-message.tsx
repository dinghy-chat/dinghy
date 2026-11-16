/** @jsxImportSource react */
import { useId, useRef } from "react";
import { insertEmoji } from "../../../packages/widget/src/emoji.ts";
import { LOCALES, type Locale, MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import type { CampaignDefinition, CampaignTrigger, Member } from "./api.ts";
import { keyFromName, withPart } from "./campaign-draft.ts";
import { Icon } from "./icons.tsx";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Switch } from "./ui.tsx";

export type CampaignMessage = CampaignDefinition["message"];
type Button = NonNullable<CampaignMessage["buttons"]>[number];
type Translation = NonNullable<CampaignMessage["translations"]>[Locale];
/** The message's own text, or one of its translations. */
export type Language = "default" | Locale;

const BUTTONS_MAX = 4;

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

/** The variables the text can read, for the campaign's trigger. */
function variablesFor(trigger: CampaignTrigger["type"]): string[] {
  const contact = ["firstName", "name", "email", "userId", "language", "country", "timeZone"];
  const extra =
    trigger === "api" ? ["data.plan"] : trigger === "event" ? ["event.properties.rows"] : [];
  return [...contact, "attributes.plan", ...extra];
}

/** The text, with the variables it may read as chips that go in at the caret. */
function BodyField({
  body,
  trigger,
  onChange,
}: {
  body: string;
  trigger: CampaignTrigger["type"];
  onChange(body: string): void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>{t("campaignBody")}</span>
      </label>
      <textarea
        ref={box}
        id={id}
        rows={4}
        required
        maxLength={MESSAGE_MAX}
        value={body}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="variable-chips">
        <span className="hint">{t("campaignVariables")}</span>
        {variablesFor(trigger).map((name) => (
          <button
            key={name}
            type="button"
            className="chip"
            onClick={() => {
              // It puts any text at the caret, as it does an emoji.
              if (box.current !== null) onChange(insertEmoji(box.current, `{{ ${name} }}`));
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <small className="hint">{t("campaignVariablesHelp")}</small>
    </div>
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
    <li className="button-row">
      <input
        aria-label={t("buttonLabel")}
        placeholder={t("buttonLabel")}
        required
        maxLength={40}
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
        maxLength={100}
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
    </li>
  );
}

/** Up to four buttons, each with a value, so results count clicks in every language. */
function ButtonsField({
  buttons,
  onChange,
}: {
  buttons: Button[];
  onChange(buttons: Button[] | undefined): void;
}) {
  const set = (next: Button[]) => onChange(next.length === 0 ? undefined : next);
  return (
    <div className="field">
      <span>{t("campaignButtons")}</span>
      {buttons.length > 0 && (
        <ul className="button-rows">
          {buttons.map((button, index) => (
            <ButtonRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a button has no ID, and its place is its name.
              key={index}
              button={button}
              onChange={(next) =>
                set(
                  buttons.flatMap((one, at) =>
                    at !== index ? [one] : next === null ? [] : [next],
                  ),
                )
              }
            />
          ))}
        </ul>
      )}
      {buttons.length < BUTTONS_MAX && (
        <button
          type="button"
          className="text-button"
          onClick={() => set([...buttons, { label: "", value: "" }])}
        >
          {t("buttonAdd")}
        </button>
      )}
    </div>
  );
}

const SENDER_AUTHOR = "author";
const SENDER_TEAM = "team";

/** Who the visitor sees: whoever saved it last, the team, or a member. */
function SenderField({
  sender,
  members,
  onChange,
}: {
  sender: CampaignMessage["sender"];
  members: Member[];
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
    <div className="field">
      <span>{t("campaignSender")}</span>
      <Select
        label={t("campaignSender")}
        value={value}
        choices={[
          { value: SENDER_AUTHOR, label: t("senderAuthor") },
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

/** The languages the message has, as tabs, with a way to add the others. */
function LanguageTabs({
  message,
  language,
  onLanguage,
  onChange,
}: {
  message: CampaignMessage;
  language: Language;
  onLanguage(language: Language): void;
  onChange(message: CampaignMessage): void;
}) {
  const translated = LOCALES.filter((one) => message.translations?.[one] !== undefined);
  const missing = LOCALES.filter((one) => !translated.includes(one));
  return (
    <div className="language-tabs">
      <Choices<Language>
        label={t("campaignLanguages")}
        variant="tabs"
        value={language}
        options={[
          { value: "default", label: "campaignDefaultLanguage" },
          ...translated.map((one) => ({ value: one, label: LOCALE_TEXT[one] })),
        ]}
        onChange={onLanguage}
      />
      {missing.map((one) => (
        <button
          key={one}
          type="button"
          className="text-button"
          onClick={() => {
            const translation: Translation = { body: message.body };
            onChange({ ...message, translations: { ...message.translations, [one]: translation } });
            onLanguage(one);
          }}
        >
          {t("campaignAddLanguage", { language: t(LOCALE_TEXT[one]) })}
        </button>
      ))}
    </div>
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
      />
      <Switch
        label={t("translationButtons")}
        hint={t("translationButtonsHelp")}
        checked={translation.buttons !== undefined}
        onChange={(own) =>
          set(withPart(translation, "buttons", own ? (message.buttons ?? []) : undefined))
        }
      />
      {translation.buttons !== undefined && (
        <ButtonsField
          buttons={translation.buttons}
          onChange={(buttons) => set(withPart(translation, "buttons", buttons ?? []))}
        />
      )}
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
    </>
  );
}

/** Who sends the message, its text with variables, its buttons and its translations. */
export function MessageFields({
  message,
  trigger,
  members,
  language,
  onLanguage,
  onChange,
}: {
  message: CampaignMessage;
  trigger: CampaignTrigger["type"];
  members: Member[];
  /** The language on show, which the preview shows too. */
  language: Language;
  onLanguage(language: Language): void;
  onChange(message: CampaignMessage): void;
}) {
  // A variant may lack the language that the campaign's own message has.
  const shown = language !== "default" && message.translations?.[language] ? language : "default";
  return (
    <div className="message-fields">
      <SenderField
        sender={message.sender}
        members={members}
        onChange={(sender) => onChange(withPart(message, "sender", sender))}
      />
      <LanguageTabs
        message={message}
        language={shown}
        onLanguage={onLanguage}
        onChange={onChange}
      />
      {shown === "default" ? (
        <>
          <BodyField
            body={message.body}
            trigger={trigger}
            onChange={(body) => onChange({ ...message, body })}
          />
          <ButtonsField
            buttons={message.buttons ?? []}
            onChange={(buttons) => onChange(withPart(message, "buttons", buttons))}
          />
        </>
      ) : (
        <TranslationFields
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
