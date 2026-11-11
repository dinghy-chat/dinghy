/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { clearPreview, renderPreview } from "../../../packages/widget/src/preview.tsx";
import {
  DEFAULT_COLORS,
  firstName,
  RADIUS_MAX_PX,
  type SavedAppearance,
  TEXT_MAX,
  type TeamFace,
  TITLE_MAX,
  type WidgetSettings,
} from "../../../packages/widget/src/shared.ts";
import { t as widgetText } from "../../../packages/widget/src/text.ts";
import type { Me, WorkspaceApi } from "./api.ts";
import { type TextId, t } from "./text.ts";
import {
  Field,
  failureText,
  ImageUpload,
  Loading,
  type Note,
  SaveNote,
  type UploadText,
} from "./ui.tsx";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const LOGO_TEXT: UploadText = {
  upload: "logoUpload",
  replace: "logoReplace",
  remove: "logoRemove",
  preview: "logoPreview",
  saved: "logoSaved",
  removed: "logoRemoved",
  tooLarge: "logoTooLarge",
};

type Option<T> = { value: T; label: TextId };

const SIDES: Option<WidgetSettings["position"]>[] = [
  { value: "left", label: "widgetSideLeft" },
  { value: "right", label: "widgetSideRight" },
];
const THEMES: Option<WidgetSettings["theme"]>[] = [
  { value: "auto", label: "widgetThemeAuto" },
  { value: "light", label: "themeLight" },
  { value: "dark", label: "themeDark" },
];
/** The visitor's device, which an auto theme follows in the preview. */
const DEVICES: Option<"light" | "dark">[] = [
  { value: "light", label: "themeLight" },
  { value: "dark", label: "themeDark" },
];
const LAUNCHERS: Option<WidgetSettings["launcher"]>[] = [
  { value: "boat", label: "widgetLauncherBoat" },
  { value: "bubble", label: "widgetLauncherBubble" },
  { value: "hidden", label: "widgetLauncherHidden" },
];
const EMAIL_ASKS: Option<WidgetSettings["emailAsk"]>[] = [
  { value: "off", label: "widgetEmailOff" },
  { value: "after_first", label: "widgetEmailAfter" },
  { value: "before_first", label: "widgetEmailBefore" },
];

/** What the form edits: the saved answer without the logo and the team. */
function editable({ logoUrl: _logo, team: _team, ...settings }: SavedAppearance): WidgetSettings {
  return settings;
}

// Every value is a string, a number, a boolean or null, so === compares each one whole.
const sameSettings = (one: WidgetSettings, other: WidgetSettings) =>
  (Object.keys(one) as (keyof WidgetSettings)[]).every((key) => one[key] === other[key]);

/** The browser asks before it leaves the page while a change is not saved. */
function useLeaveGuard(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", guard);
    return () => removeEventListener("beforeunload", guard);
  }, [unsaved]);
}

/** A heading and its controls, one part of the form. */
function FormSection({
  title,
  help,
  children,
}: {
  title: TextId;
  help?: TextId;
  children: ReactNode;
}) {
  return (
    <section className="widget-section">
      <div>
        <h3>{t(title)}</h3>
        {help !== undefined && <p className="hint">{t(help)}</p>}
      </div>
      {children}
    </section>
  );
}

/** Radio buttons drawn as pills, under a label that can be for screen readers only. */
function Choices<T extends string>({
  label,
  hideLabel = false,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  hint?: string | undefined;
  value: T;
  options: Option<T>[];
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <fieldset className="widget-field">
      <legend className={hideLabel ? "visually-hidden" : undefined}>{label}</legend>
      <div className="choices">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {t(option.label)}
          </label>
        ))}
      </div>
      {hint !== undefined && <small className="hint">{hint}</small>}
    </fieldset>
  );
}

/** A color picker and its hex code. Null keeps the widget's own color. */
function ColorField({
  label,
  hint,
  value,
  fallback,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  fallback: string;
  onChange(value: string | null): void;
}) {
  const shown = value ?? fallback;
  // The code as typed, which changes the color once it is whole.
  const [typed, setTyped] = useState(shown);
  useEffect(() => setTyped(shown), [shown]);
  return (
    <fieldset className="widget-field">
      <legend>{label}</legend>
      <div className="color-field">
        <input
          type="color"
          aria-label={label}
          value={shown}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
        />
        <input
          className="mono"
          aria-label={t("widgetColorHex", { color: label })}
          spellCheck={false}
          maxLength={7}
          value={typed}
          onChange={(event) => {
            const next = event.target.value.trim();
            setTyped(next);
            if (HEX_COLOR.test(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setTyped(shown)}
        />
        {value !== null && (
          <button type="button" className="text-button" onClick={() => onChange(null)}>
            {t("widgetColorDefault")}
          </button>
        )}
      </div>
      <small className="hint">{hint}</small>
    </fieldset>
  );
}

/** An on or off setting, as a switch. */
function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="check">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** The widget's three texts. An empty box keeps the widget's own words. */
function TextFields({
  settings,
  onChange,
}: {
  settings: WidgetSettings;
  onChange(change: Partial<WidgetSettings>): void;
}) {
  const field = (name: "title" | "greeting" | "away") => ({
    value: settings[name] ?? "",
    // The server takes no blank text: an empty box is the default.
    onChange: (value: string) => onChange({ [name]: value.trim() === "" ? null : value }),
  });
  return (
    <>
      <Field
        label={t("widgetTitleLabel")}
        placeholder={widgetText("title")}
        maxLength={TITLE_MAX}
        {...field("title")}
      />
      <Field
        label={t("widgetGreetingLabel")}
        multiline
        placeholder={widgetText("empty")}
        maxLength={TEXT_MAX}
        {...field("greeting")}
      />
      <Field
        label={t("widgetAwayLabel")}
        multiline
        placeholder={widgetText("teamAway")}
        maxLength={TEXT_MAX}
        {...field("away")}
      />
    </>
  );
}

/** The colors, the side, the theme, the launcher, the corners and the boat. */
function LookFields({
  settings,
  onChange,
}: {
  settings: WidgetSettings;
  onChange(change: Partial<WidgetSettings>): void;
}) {
  return (
    <>
      <ColorField
        label={t("widgetColorPrimary")}
        hint={t("widgetColorPrimaryHelp")}
        value={settings.primary}
        fallback={DEFAULT_COLORS.primary}
        onChange={(primary) => onChange({ primary })}
      />
      <ColorField
        label={t("widgetColorAccent")}
        hint={t("widgetColorAccentHelp")}
        value={settings.accent}
        fallback={DEFAULT_COLORS.accent}
        onChange={(accent) => onChange({ accent })}
      />
      <Choices
        label={t("widgetSide")}
        value={settings.position}
        options={SIDES}
        onChange={(position) => onChange({ position })}
      />
      <Choices
        label={t("widgetTheme")}
        hint={t("widgetThemeHelp")}
        value={settings.theme}
        options={THEMES}
        onChange={(theme) => onChange({ theme })}
      />
      <Choices
        label={t("widgetLauncher")}
        hint={settings.launcher === "hidden" ? t("widgetLauncherHiddenHelp") : undefined}
        value={settings.launcher}
        options={LAUNCHERS}
        onChange={(launcher) => onChange({ launcher })}
      />
      <label className="field">
        <span>{t("widgetRadius")}</span>
        <div className="radius-field">
          <input
            type="range"
            min={0}
            max={RADIUS_MAX_PX}
            value={settings.radius}
            onChange={(event) => onChange({ radius: Number(event.target.value) })}
          />
          <output>{t("widgetRadiusValue", { radius: String(settings.radius) })}</output>
        </div>
      </label>
      <Switch
        label={t("widgetMascot")}
        checked={settings.mascot}
        onChange={(mascot) => onChange({ mascot })}
      />
    </>
  );
}

/** The chat as visitors will see it, drawn by the widget's own code in a Shadow DOM. */
function WidgetPreview({ appearance, me }: { appearance: SavedAppearance; me: Me }) {
  const host = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  // An auto theme follows the visitor's device, which the operator picks here.
  const [device, setDevice] = useState<"light" | "dark">("light");
  const theme = appearance.theme === "auto" ? device : appearance.theme;
  // On a phone the preview sits above the form, and folds away.
  const [folded, setFolded] = useState(false);
  // A member who replied lately, or the operator who looks, answers the sample question. Visitors
  // see the first word of a name, as the server sends it.
  const author: TeamFace = appearance.team[0] ?? {
    id: me.id,
    name: firstName(me.name),
    pictureUrl: me.pictureUrl,
  };
  // On every render, so each change in the form shows at once.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    renderPreview(shadow, {
      appearance,
      open,
      theme,
      sample: { question: t("previewQuestion"), answer: t("previewAnswer"), author },
    });
  });
  // With the tab, so the sea's animation frames and listeners stop.
  useEffect(() => {
    const shadow = host.current?.shadowRoot;
    return () => {
      if (shadow) clearPreview(shadow);
    };
  }, []);
  return (
    <section className="widget-preview" aria-label={t("previewTitle")} data-folded={folded}>
      <div className="preview-bar">
        <h3>{t("previewTitle")}</h3>
        <button
          type="button"
          className="text-button preview-fold"
          onClick={() => setFolded(!folded)}
        >
          {t(folded ? "previewShow" : "previewHide")}
        </button>
      </div>
      <div className="preview-body">
        <div className="preview-toggles">
          <Choices
            label={t("previewState")}
            hideLabel
            value={open ? "open" : "closed"}
            options={[
              { value: "open", label: "previewOpen" },
              { value: "closed", label: "previewClosed" },
            ]}
            onChange={(next) => setOpen(next === "open")}
          />
          {appearance.theme === "auto" && (
            <Choices
              label={t("previewDevice")}
              hideLabel
              value={device}
              options={DEVICES}
              onChange={(next) => setDevice(next)}
            />
          )}
        </div>
        <div className="preview-stage" data-dark={theme === "dark"}>
          {/* A picture of the widget: its sample buttons do nothing, so nothing can reach them. */}
          <div ref={host} inert />
          {!open && appearance.launcher === "hidden" && (
            <p className="hint">{t("previewLauncherHidden")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The widget's look, words and behavior, with a live preview. Every member sees it, and only an
 * owner or an admin changes it. One Save sends the form. The logo saves on its own, at once.
 */
export function WidgetTab({
  api,
  me,
  canEdit,
  onLogoChanged,
}: {
  api: WorkspaceApi;
  me: Me;
  canEdit: boolean;
  onLogoChanged(logoUrl: string | null): void;
}) {
  const [saved, setSaved] = useState<SavedAppearance | null>(null);
  const [draft, setDraft] = useState<WidgetSettings | null>(null);
  const [loadFailure, setLoadFailure] = useState<TextId | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const unsaved = saved !== null && draft !== null && !sameSettings(editable(saved), draft);
  useLeaveGuard(unsaved);

  useEffect(() => {
    let current = true;
    api.widget().then(
      (answer) => {
        if (!current) return;
        setSaved(answer);
        setDraft(editable(answer));
      },
      (failure: unknown) => {
        if (current) setLoadFailure(failureText(failure, {}, "actionFailed"));
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  if (saved === null || draft === null) return <Loading failure={loadFailure} />;

  const change = (next: Partial<WidgetSettings>) => {
    setDraft({ ...draft, ...next });
    setNote(null);
  };
  /** The logo saves at once, and the form keeps its unsaved changes. */
  const logoSaved = (answer: SavedAppearance) => {
    setSaved(answer);
    onLogoChanged(answer.logoUrl);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const answer = await api.setWidget(draft);
      setSaved(answer);
      setDraft(editable(answer));
      setNote({ ok: true, text: "widgetSaved" });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, {}) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="widget-tab">
      <WidgetPreview appearance={{ ...saved, ...draft }} me={me} />
      <form className="widget-form" onSubmit={save}>
        {!canEdit && <p className="note">{t("widgetMemberNote")}</p>}
        <fieldset className="widget-sections" disabled={!canEdit}>
          <FormSection title="logoTitle" help="logoHelp">
            <ImageUpload
              url={saved.logoUrl}
              text={LOGO_TEXT}
              onUpload={async (file) => logoSaved(await api.setLogo(file))}
              onRemove={async () => logoSaved(await api.removeLogo())}
            />
          </FormSection>
          <FormSection title="widgetTextsTitle" help="widgetTextsHelp">
            <TextFields settings={draft} onChange={change} />
          </FormSection>
          <FormSection title="widgetLookTitle">
            <LookFields settings={draft} onChange={change} />
          </FormSection>
          <FormSection title="widgetBehaviorTitle">
            <Choices
              label={t("widgetEmailAsk")}
              hint={t("widgetEmailAskHelp")}
              value={draft.emailAsk}
              options={EMAIL_ASKS}
              onChange={(emailAsk) => change({ emailAsk })}
            />
            <Switch
              label={t("widgetBranding")}
              checked={draft.branding}
              onChange={(branding) => change({ branding })}
            />
          </FormSection>
        </fieldset>
        {canEdit && (
          <div className="widget-save">
            <button type="submit" className="pill dark" disabled={busy || !unsaved}>
              {t("save")}
            </button>
            <SaveNote note={note} />
          </div>
        )}
      </form>
    </div>
  );
}
