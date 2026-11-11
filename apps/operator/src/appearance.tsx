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
import { useLoad } from "./load.ts";
import { setLeaveGuard } from "./nav.ts";
import { Confirm } from "./popup.tsx";
import { settingsAddress } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import {
  AppLink,
  Choices,
  DocLink,
  ErrorNote,
  Field,
  failureText,
  Loading,
  type Option,
  Page,
} from "./ui.tsx";

const HIDDEN_BUTTON_DOC = {
  path: "add-to-your-site#use-your-own-button",
  text: "hiddenButtonDocsLink",
} as const;

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
 * this dialog before the app moves to another page, view or workspace.
 */
function LeaveGuard({ unsaved }: { unsaved: boolean }) {
  const [asked, setAsked] = useState<{ move(): void; stay(): void } | null>(null);
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", guard);
    setLeaveGuard((move, stay) => setAsked({ move, stay }));
    return () => {
      removeEventListener("beforeunload", guard);
      setLeaveGuard(null);
    };
  }, [unsaved]);
  if (asked === null) return null;
  return (
    <Confirm
      title={t("widgetLeaveTitle")}
      text={t("widgetLeaveText")}
      confirm={t("widgetLeaveYes")}
      cancel={t("widgetStay")}
      onConfirm={() => {
        setAsked(null);
        asked.move();
      }}
      onCancel={() => {
        setAsked(null);
        asked.stay();
      }}
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
  describedBy,
  value,
  fallback,
  onChange,
}: {
  label: string;
  describedBy: string | undefined;
  value: string | null;
  fallback: string;
  onChange(value: string | null): void;
}) {
  const shown = value ?? fallback;
  // The code as typed, which changes the color once it is whole. A new color from the picker or a
  // reset replaces it, during render, so the box never shows an old code.
  const [typed, setTyped] = useState(shown);
  const [lastShown, setLastShown] = useState(shown);
  if (shown !== lastShown) {
    setLastShown(shown);
    setTyped(shown);
  }
  return (
    <div className="color-field">
      <span className="color-box">
        <input
          type="color"
          aria-label={label}
          aria-describedby={describedBy}
          value={shown}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
        />
        <input
          className="mono"
          aria-label={t("widgetColorHex", { color: label })}
          aria-describedby={describedBy}
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
 * One line of the "Colors and layout" and "Email and branding" sections: the label and its hint on
 * the left, the control on the right.
 */
function SettingRow({
  label,
  hint,
  doc,
  stacked = false,
  children,
}: {
  label: string;
  hint?: string | undefined;
  /** A docs section that explains the setting, as a link under the hint. */
  doc?: { path: string; text: TextId } | undefined;
  /** The control goes under the label, for a control too wide to share the line. */
  stacked?: boolean;
  /** The control, which names the hint with this ID, so a screen reader reads it too. */
  children(hintId: string | undefined): ReactNode;
}) {
  const hintId = useId();
  return (
    <div className={stacked ? "setting-row setting-stacked" : "setting-row"}>
      <div className="setting-label">
        <span aria-hidden="true">{label}</span>
        {hint !== undefined && (
          <small className="hint" id={hintId}>
            {hint}
          </small>
        )}
        {doc !== undefined && <DocLink path={doc.path} text={doc.text} />}
      </div>
      {children(hint === undefined ? undefined : hintId)}
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
      <span className="setting-label">
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
function LayoutFields({
  settings,
  onChange,
}: {
  settings: WidgetSettings;
  onChange(change: Partial<WidgetSettings>): void;
}) {
  // Each control carries its own accessible name, so the visible label is for the eye only.
  return (
    <div className="setting-rows">
      <SettingRow label={t("widgetColorPrimary")} hint={t("widgetColorPrimaryHelp")}>
        {(hintId) => (
          <ColorField
            describedBy={hintId}
            label={t("widgetColorPrimary")}
            value={settings.primary}
            fallback={DEFAULT_COLORS.primary}
            onChange={(primary) => onChange({ primary })}
          />
        )}
      </SettingRow>
      <SettingRow
        label={t("widgetColorAccent")}
        hint={t("widgetColorAccentHelp")}
        doc={{ path: "add-to-your-site#change-how-it-looks", text: "appearanceDocsLink" }}
      >
        {(hintId) => (
          <ColorField
            describedBy={hintId}
            label={t("widgetColorAccent")}
            value={settings.accent}
            fallback={DEFAULT_COLORS.accent}
            onChange={(accent) => onChange({ accent })}
          />
        )}
      </SettingRow>
      <SettingRow label={t("widgetSide")}>
        {(hintId) => (
          <Choices
            describedBy={hintId}
            label={t("widgetSide")}
            variant="outlined"
            value={settings.position}
            options={SIDES}
            onChange={(position) => onChange({ position })}
          />
        )}
      </SettingRow>
      <SettingRow label={t("widgetTheme")} hint={t("widgetThemeHelp")}>
        {(hintId) => (
          <Choices
            describedBy={hintId}
            label={t("widgetTheme")}
            variant="outlined"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => onChange({ theme })}
          />
        )}
      </SettingRow>
      <SettingRow
        label={t("widgetLauncher")}
        hint={settings.launcher === "hidden" ? t("widgetLauncherHiddenHelp") : undefined}
        doc={settings.launcher === "hidden" ? HIDDEN_BUTTON_DOC : undefined}
      >
        {(hintId) => (
          <Choices
            describedBy={hintId}
            label={t("widgetLauncher")}
            variant="outlined"
            value={settings.launcher}
            options={LAUNCHERS}
            onChange={(launcher) => onChange({ launcher })}
          />
        )}
      </SettingRow>
      <SettingRow label={t("widgetRadius")}>
        {() => (
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
        )}
      </SettingRow>
      <div className="setting-row setting-switch">
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
  // With the page, so the sea's animation frames and listeners stop.
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
            label={t("previewDevice")}
            value={device}
            options={DEVICES}
            onChange={(next) => setDevice(next)}
          />
        )}
        <div className="preview-stage">
          {/* A picture of the widget: its sample buttons do nothing, so nothing can reach them. */}
          <div ref={host} inert />
          {appearance.launcher === "hidden" && <p className="hint">{t("previewLauncherHidden")}</p>}
        </div>
      </div>
    </section>
  );
}

/** Where the logo was: it belongs to the workspace now, and its page changes it. */
function LogoNote({
  workspaceId,
  onOpenWorkspace,
}: {
  workspaceId: string;
  onOpenWorkspace(): void;
}) {
  const [before, after] = t("appearanceLogoNote").split("{workspace}");
  return (
    <p className="hint">
      {before}
      <AppLink href={settingsAddress("workspace", workspaceId)} onOpen={onOpenWorkspace}>
        {t("pageWorkspace")}
      </AppLink>
      {after}
    </p>
  );
}

/**
 * The widget's look, words and behavior, with a live preview. Every member sees it, and only an
 * owner or an admin changes it. One Save sends the form.
 */
export function AppearancePage(props: AppearanceProps) {
  return (
    <Page title={t("pageAppearance")}>
      <AppearanceForm {...props} />
    </Page>
  );
}

interface AppearanceProps {
  api: WorkspaceApi;
  me: Me;
  workspaceId: string;
  canEdit: boolean;
  onOpenWorkspace(): void;
}

function AppearanceForm({ api, me, workspaceId, canEdit, onOpenWorkspace }: AppearanceProps) {
  const loaded = useLoad(() => api.widget(), [api]);
  const saved = loaded.data;
  // Null until the first change, so the form shows what is saved until then.
  const [edited, setEdited] = useState<WidgetSettings | null>(null);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const unsaved = saved !== null && edited !== null && !sameSettings(editable(saved), edited);

  if (saved === null) return <Loading failure={loaded.failure} />;
  const draft = edited ?? editable(saved);

  const change = (next: Partial<WidgetSettings>) => {
    setEdited({ ...draft, ...next });
    setError(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      loaded.setData(await api.setWidget(draft));
      setEdited(null);
      toast("widgetSaved");
    } catch (failure) {
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="appearance">
      <LeaveGuard unsaved={unsaved} />
      <WidgetPreview appearance={{ ...saved, ...draft }} me={me} />
      <form className="widget-form" onSubmit={save}>
        {!canEdit && <p className="note">{t("widgetMemberNote")}</p>}
        <fieldset className="widget-sections" disabled={!canEdit}>
          {canEdit && (
            <FormSection title="logoTitle">
              <LogoNote workspaceId={workspaceId} onOpenWorkspace={onOpenWorkspace} />
            </FormSection>
          )}
          <FormSection title="widgetTextsTitle" help="widgetTextsHelp">
            <TextFields settings={draft} onChange={change} />
          </FormSection>
          <FormSection title="widgetLayoutTitle">
            <LayoutFields settings={draft} onChange={change} />
          </FormSection>
          <FormSection title="widgetEmailTitle">
            <div className="setting-rows">
              <SettingRow
                label={t("widgetEmailAsk")}
                hint={t("widgetEmailAskHelp")}
                doc={{ path: "add-to-your-site#what-visitors-can-do", text: "emailAskDocsLink" }}
                stacked
              >
                {(hintId) => (
                  <Choices
                    describedBy={hintId}
                    label={t("widgetEmailAsk")}
                    variant="outlined"
                    value={draft.emailAsk}
                    options={EMAIL_ASKS}
                    onChange={(emailAsk) => change({ emailAsk })}
                  />
                )}
              </SettingRow>
              <div className="setting-row setting-switch">
                <Switch
                  label={t("widgetSound")}
                  hint={t("widgetSoundHelp")}
                  checked={draft.sound}
                  onChange={(sound) => change({ sound })}
                />
              </div>
              <div className="setting-row setting-switch">
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
            <ErrorNote text={error} />
          </div>
        )}
      </form>
    </div>
  );
}
