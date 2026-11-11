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
import { hexColor } from "./hex-color.ts";
import { setLeaveGuard } from "./nav.ts";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import {
  Choices,
  Field,
  failureText,
  ImageUpload,
  Loading,
  type Note,
  type Option,
  SaveNote,
  type UploadText,
} from "./ui.tsx";

const LOGO_TEXT: UploadText = {
  upload: "logoUpload",
  replace: "logoReplace",
  remove: "logoRemove",
  preview: "logoPreview",
  tooLarge: "logoTooLarge",
};

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
  { value: "bubble", label: "widgetLauncherBubble" },
  { value: "label", label: "widgetLauncherLabel" },
  { value: "square", label: "widgetLauncherSquare" },
  { value: "boat", label: "widgetLauncherBoat" },
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

/**
 * Asks before a change that is not saved is lost: the browser asks before it leaves the page, and
 * this dialog before the app moves to another tab, view or workspace.
 */
function LeaveGuard({ unsaved }: { unsaved: boolean }) {
  const [move, setMove] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", guard);
    // A function in state must be wrapped, or React calls it as an updater.
    setLeaveGuard((next) => setMove(() => next));
    return () => {
      removeEventListener("beforeunload", guard);
      setLeaveGuard(null);
    };
  }, [unsaved]);
  if (move === null) return null;
  return (
    <Confirm
      title={t("widgetLeaveTitle")}
      text={t("widgetLeaveText")}
      confirm={t("widgetLeaveYes")}
      cancel={t("widgetStay")}
      onConfirm={() => {
        setMove(null);
        move();
      }}
      onCancel={() => setMove(null)}
    />
  );
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

/** A color picker and its hex code in one box. Null keeps the widget's own color. */
function ColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | null;
  fallback: string;
  onChange(value: string | null): void;
}) {
  const shown = value ?? fallback;
  // The code as typed, which changes the color once it is whole.
  const [typed, setTyped] = useState(shown);
  useEffect(() => setTyped(shown), [shown]);
  return (
    <div className="color-field">
      <span className="color-box">
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
          value={typed}
          onChange={(event) => {
            const next = event.target.value;
            const color = hexColor(next);
            setTyped(color ?? next);
            if (color !== null) onChange(color);
          }}
          onBlur={() => setTyped(shown)}
        />
      </span>
      {value !== null && (
        <button type="button" className="text-button" onClick={() => onChange(null)}>
          {t("widgetColorDefault")}
        </button>
      )}
    </div>
  );
}

/**
 * One line of the Look and Behavior sections: the label and its hint on the left, the control on
 * the right.
 */
function LookRow({
  label,
  hint,
  stacked = false,
  children,
}: {
  label: string;
  hint?: string | undefined;
  /** The control goes under the label, for a control too wide to share the line. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={stacked ? "look-row look-stacked" : "look-row"}>
      <div className="look-label">
        <span aria-hidden="true">{label}</span>
        {hint !== undefined && <small className="hint">{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/** An on or off setting, as a switch, with a hint under its label. */
function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const hintId = useId();
  return (
    <label className="check">
      <span className="look-label">
        {label}
        {hint !== undefined && (
          <small className="hint" id={hintId}>
            {hint}
          </small>
        )}
      </span>
      {/* Named by the label alone, and described by the hint. */}
      <input
        aria-label={label}
        aria-describedby={hint === undefined ? undefined : hintId}
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
        emoji
        {...field("title")}
      />
      <Field
        label={t("widgetGreetingLabel")}
        multiline
        placeholder={widgetText("empty")}
        maxLength={TEXT_MAX}
        emoji
        {...field("greeting")}
      />
      <Field
        label={t("widgetAwayLabel")}
        multiline
        placeholder={widgetText("teamAway")}
        maxLength={TEXT_MAX}
        emoji
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
  // Each control carries its own accessible name, so the visible label is for the eye only.
  return (
    <div className="look-rows">
      <LookRow label={t("widgetColorPrimary")} hint={t("widgetColorPrimaryHelp")}>
        <ColorField
          label={t("widgetColorPrimary")}
          value={settings.primary}
          fallback={DEFAULT_COLORS.primary}
          onChange={(primary) => onChange({ primary })}
        />
      </LookRow>
      <LookRow label={t("widgetColorAccent")} hint={t("widgetColorAccentHelp")}>
        <ColorField
          label={t("widgetColorAccent")}
          value={settings.accent}
          fallback={DEFAULT_COLORS.accent}
          onChange={(accent) => onChange({ accent })}
        />
      </LookRow>
      <LookRow label={t("widgetSide")}>
        <Choices
          className="widget-field"
          label={t("widgetSide")}
          hideLabel
          value={settings.position}
          options={SIDES}
          onChange={(position) => onChange({ position })}
        />
      </LookRow>
      <LookRow label={t("widgetTheme")} hint={t("widgetThemeHelp")}>
        <Choices
          className="widget-field"
          label={t("widgetTheme")}
          hideLabel
          value={settings.theme}
          options={THEMES}
          onChange={(theme) => onChange({ theme })}
        />
      </LookRow>
      <LookRow
        label={t("widgetLauncher")}
        hint={settings.launcher === "hidden" ? t("widgetLauncherHiddenHelp") : undefined}
      >
        <Choices
          className="widget-field"
          label={t("widgetLauncher")}
          hideLabel
          value={settings.launcher}
          options={LAUNCHERS}
          onChange={(launcher) => onChange({ launcher })}
        />
      </LookRow>
      <LookRow label={t("widgetRadius")}>
        <div className="radius-field">
          <input
            type="range"
            aria-label={t("widgetRadius")}
            min={0}
            max={RADIUS_MAX_PX}
            value={settings.radius}
            onChange={(event) => onChange({ radius: Number(event.target.value) })}
          />
          <output>{t("widgetRadiusValue", { radius: String(settings.radius) })}</output>
        </div>
      </LookRow>
      <div className="look-row look-switch">
        <Switch
          label={t("widgetMascot")}
          hint={t("widgetMascotHelp")}
          checked={settings.mascot}
          onChange={(mascot) => onChange({ mascot })}
        />
      </div>
    </div>
  );
}

/** The chat as visitors will see it, drawn by the widget's own code in a Shadow DOM. */
function WidgetPreview({ appearance, me }: { appearance: SavedAppearance; me: Me }) {
  const host = useRef<HTMLDivElement>(null);
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
        {appearance.theme === "auto" && (
          <Choices
            className="widget-field"
            label={t("previewDevice")}
            hideLabel
            value={device}
            options={DEVICES}
            onChange={(next) => setDevice(next)}
          />
        )}
        <div className="preview-stage" data-dark={theme === "dark"}>
          {/* A picture of the widget: its sample buttons do nothing, so nothing can reach them. */}
          <div ref={host} inert />
          {appearance.launcher === "hidden" && <p className="hint">{t("previewLauncherHidden")}</p>}
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
      <LeaveGuard unsaved={unsaved} />
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
            <div className="look-rows">
              <LookRow label={t("widgetEmailAsk")} hint={t("widgetEmailAskHelp")} stacked>
                <Choices
                  className="widget-field"
                  label={t("widgetEmailAsk")}
                  hideLabel
                  value={draft.emailAsk}
                  options={EMAIL_ASKS}
                  onChange={(emailAsk) => change({ emailAsk })}
                />
              </LookRow>
              <div className="look-row look-switch">
                <Switch
                  label={t("widgetBranding")}
                  checked={draft.branding}
                  onChange={(branding) => change({ branding })}
                />
              </div>
            </div>
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
