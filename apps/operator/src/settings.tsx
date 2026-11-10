/** @jsxImportSource react */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { t as widgetText } from "../../../packages/widget/src/text.ts";
import {
  type BillingState,
  type Me,
  type Role,
  type Usage,
  updateName,
  type WorkspaceApi,
  type WorkspaceSettings,
} from "./api.ts";
import { ApiKeysRow, WebhooksRow } from "./integrations.tsx";
import { Confirm } from "./popup.tsx";
import { BlockedRow, InviteDialog, imagesText, operatorsText, TeamTab, useTeam } from "./team.tsx";
import { type TextId, t } from "./text.ts";
import { savedTheme, setTheme, type Theme } from "./theme.ts";
import {
  CopyButton,
  ErrorNote,
  Field,
  failureText,
  Icon,
  type IconName,
  type Note,
  Page,
  PageRow,
  SaveNote,
  StatusNote,
} from "./ui.tsx";

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="code-block">
      <pre>{value}</pre>
      <CopyButton value={value} />
    </div>
  );
}

function SnippetRow({ publicKey, waiting }: { publicKey: string; waiting: boolean }) {
  // A workspace that waits for the cloud serves no widget, so its code would not work yet.
  if (waiting) {
    return (
      <PageRow title={t("snippetTitle")}>
        <p className="quiet">{t("snippetWaiting")}</p>
      </PageRow>
    );
  }
  // One attribute per line, so no screen breaks the tag inside an attribute.
  const snippet = [
    "<script",
    `  src="${location.origin}/widget/loader.js"`,
    `  data-key="${publicKey}"`,
    "  async></script>",
  ].join("\n");
  return (
    <PageRow title={t("snippetTitle")} help={t("snippetHelp")}>
      <CodeBlock value={snippet} />
    </PageRow>
  );
}

/** The widget's title, greeting and away text. An empty box means the widget's own default. */
function WidgetTextsRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const [texts, setTexts] = useState(() => ({
    title: settings.widgetTexts.title ?? "",
    greeting: settings.widgetTexts.greeting ?? "",
    away: settings.widgetTexts.away ?? "",
  }));
  const [note, setNote] = useState<Note>(null);
  const field = (name: keyof typeof texts) => ({
    value: texts[name],
    onChange: (value: string) => {
      setTexts((current) => ({ ...current, [name]: value }));
      setNote(null);
    },
  });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const blank = (value: string) => (value.trim() === "" ? null : value.trim());
    try {
      const saved = await api.setWidgetTexts({
        title: blank(texts.title),
        greeting: blank(texts.greeting),
        away: blank(texts.away),
      });
      onSaved(saved);
      setNote({ ok: true, text: "widgetTextsSaved" });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, {}) });
    }
  };
  return (
    <PageRow title={t("widgetTextsTitle")} help={t("widgetTextsHelp")}>
      <form className="stack" onSubmit={save}>
        <Field
          label={t("widgetTitleLabel")}
          placeholder={widgetText("title")}
          maxLength={40}
          {...field("title")}
        />
        <Field
          label={t("widgetGreetingLabel")}
          multiline
          placeholder={widgetText("empty")}
          maxLength={200}
          {...field("greeting")}
        />
        <Field
          label={t("widgetAwayLabel")}
          multiline
          placeholder={widgetText("teamAway")}
          maxLength={200}
          {...field("away")}
        />
        <div className="actions">
          <button type="submit" className="pill dark">
            {t("save")}
          </button>
        </div>
        <SaveNote note={note} />
      </form>
    </PageRow>
  );
}

/** The browser's copy of the server's check, so a mistake shows under its own row before saving. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

interface SiteRow {
  key: number;
  value: string;
}

function OriginsRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const next = useRef(0);
  const toRows = (origins: string[]): SiteRow[] =>
    (origins.length === 0 ? [""] : origins).map((value) => ({ key: next.current++, value }));
  const [rows, setRows] = useState(() => toRows(settings.allowedOrigins));
  // Rows are checked once the operator tries to save, and then on every change.
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  useEffect(() => {
    if (focusKey === null) return;
    inputs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const wrong = (row: SiteRow) => row.value.trim() !== "" && !isOrigin(row.value.trim());
  const change = (update: (current: SiteRow[]) => SiteRow[]) => {
    setRows(update);
    setNote(null);
  };
  const add = () => {
    const key = next.current++;
    change((current) => [...current, { key, value: "" }]);
    setFocusKey(key);
  };
  const remove = (index: number) => {
    const after = rows.filter((_, at) => at !== index);
    const keep = after.length === 0 ? [{ key: next.current++, value: "" }] : after;
    change(() => keep);
    // The focus moves to the row that took this one's place.
    setFocusKey(keep[Math.min(index, keep.length - 1)]?.key ?? null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    const firstWrong = rows.find(wrong);
    if (firstWrong !== undefined) {
      inputs.current.get(firstWrong.key)?.focus();
      return;
    }
    const list = rows.map((row) => row.value.trim()).filter((value) => value !== "");
    try {
      const saved = await api.setOrigins(list);
      onSaved(saved);
      setRows(toRows(saved.allowedOrigins));
      setChecked(false);
      setNote({ ok: true, text: "originsSaved" });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, { 400: "originsBad" }) });
    }
  };

  return (
    <PageRow title={t("originsTitle")} help={t("originsHelp")}>
      <form className="stack" onSubmit={save} noValidate>
        <ul className="sites">
          {rows.map((row, index) => {
            const shown = checked && wrong(row);
            const errorId = `site-error-${row.key}`;
            const name = t("originsSite", { number: String(index + 1) });
            return (
              <li key={row.key}>
                <div className="site">
                  <input
                    ref={(element) => {
                      if (element === null) inputs.current.delete(row.key);
                      else inputs.current.set(row.key, element);
                    }}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com"
                    aria-label={name}
                    aria-invalid={shown}
                    aria-describedby={shown ? errorId : undefined}
                    value={row.value}
                    onChange={(event) => {
                      const value = event.target.value;
                      change((current) =>
                        current.map((one) => (one.key === row.key ? { ...one, value } : one)),
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("originsRemove", { site: row.value.trim() || name })}
                    onClick={() => remove(index)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                {shown && (
                  <p id={errorId} className="field-error">
                    {t("originsBadRow")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="actions spread">
          <button type="button" className="text-button" onClick={add}>
            <Icon name="plusBold" size={14} />
            {t("originsAdd")}
          </button>
          <button type="submit" className="pill dark">
            {t("save")}
          </button>
        </div>
        <SaveNote note={note} />
      </form>
    </PageRow>
  );
}

function SecretRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [replaced, setReplaced] = useState(false);
  const rotate = async () => {
    setError(null);
    setBusy(true);
    try {
      onSaved(await api.rotateSecret());
      setShown(true);
      setReplaced(true);
      setConfirming(false);
    } catch (failure) {
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageRow title={t("secretTitle")} help={t("secretHelp")}>
      <div className="copy-field">
        <input
          className="mono"
          readOnly
          aria-label={t("secretTitle")}
          type={shown ? "text" : "password"}
          value={settings.signingSecret}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="icon-button"
          aria-label={shown ? t("secretHide") : t("secretShow")}
          title={shown ? t("secretHide") : t("secretShow")}
          onClick={() => setShown((current) => !current)}
        >
          <Icon name={shown ? "eyeOff" : "eye"} size={18} />
        </button>
        <CopyButton value={settings.signingSecret} label={t("secretCopy")} />
      </div>
      {replaced && <StatusNote text="secretReplaced" />}
      <button
        type="button"
        className="pill danger-soft"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        {t("secretRotate")}
      </button>
      {confirming && (
        <Confirm
          title={t("secretConfirmTitle")}
          text={t("secretWarning")}
          confirm={t("secretConfirm")}
          disabled={busy}
          onConfirm={() => void rotate()}
          onCancel={() => setConfirming(false)}
        >
          <ErrorNote text={error} />
        </Confirm>
      )}
    </PageRow>
  );
}

/** The operator's own name and email, the same in every workspace. */
const THEMES: { value: Theme; label: TextId; icon: IconName }[] = [
  { value: "system", label: "themeSystem", icon: "monitor" },
  { value: "light", label: "themeLight", icon: "sun" },
  { value: "dark", label: "themeDark", icon: "moon" },
];

/** Light, dark, or the device's own setting. It applies at once, on this device only. */
function ThemeChoice() {
  const [theme, setThemeState] = useState(savedTheme);
  return (
    <fieldset className="choices" aria-label={t("theme")}>
      {THEMES.map((choice) => (
        <label key={choice.value}>
          <input
            type="radio"
            name="theme"
            checked={theme === choice.value}
            onChange={() => {
              setTheme(choice.value);
              setThemeState(choice.value);
            }}
          />
          <Icon name={choice.icon} size={16} />
          {t(choice.label)}
        </label>
      ))}
    </fieldset>
  );
}

export function ProfilePage({ me, onChanged }: { me: Me; onChanged(): void }) {
  const [name, setName] = useState(me.name);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await updateName(name.trim());
      setName(name.trim());
      setNote({ ok: true, text: "accountNameSaved" });
      onChanged();
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={t("profile")} context={t("profileContext")}>
      <form className="profile" onSubmit={save}>
        <PageRow title={t("accountName")} help={t("accountHelp")}>
          <div className="inline-field">
            <input
              aria-label={t("accountName")}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNote(null);
              }}
              required
              maxLength={100}
              autoComplete="name"
            />
            <button
              type="submit"
              className="pill dark"
              disabled={busy || name.trim() === "" || name.trim() === me.name}
            >
              {t("accountNameSave")}
            </button>
          </div>
          <SaveNote note={note} />
        </PageRow>
        <PageRow title={t("email")} help={t("accountEmailHelp")}>
          <input aria-label={t("email")} value={me.email} readOnly />
        </PageRow>
        <PageRow title={t("theme")} help={t("themeHelp")}>
          <ThemeChoice />
        </PageRow>
      </form>
    </Page>
  );
}

type Tab = "team" | "install" | "sites" | "secret" | "api" | "data";

const TAB_TEXT: Record<Tab, TextId> = {
  team: "tabTeam",
  install: "tabInstall",
  sites: "originsTitle",
  secret: "secretTitle",
  api: "tabApi",
  data: "tabData",
};

/** The line under the title: the workspace, its plan and how full it is. */
function settingsContext(name: string, usage: Usage | null, members: number): string {
  if (usage !== null) {
    return t("settingsContextCloud", {
      name,
      operators: operatorsText(usage),
      images: imagesText(usage),
    });
  }
  return t(members === 1 ? "settingsContextOne" : "settingsContextMany", {
    name,
    count: String(members),
  });
}

/** Pill tabs, with the arrow keys moving between them. */
function Tabs({ tabs, current, onPick }: { tabs: Tab[]; current: Tab; onPick(tab: Tab): void }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      className="tabs"
      role="tablist"
      ref={list}
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        const at = tabs.indexOf(current);
        const next =
          event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : step === undefined
                ? undefined
                : tabs[(at + step + tabs.length) % tabs.length];
        if (next === undefined) return;
        event.preventDefault();
        onPick(next);
        list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab}
          id={`tab-${tab}`}
          data-tab={tab}
          aria-selected={tab === current}
          aria-controls="tab-panel"
          tabIndex={tab === current ? 0 : -1}
          onClick={() => onPick(tab)}
        >
          {t(TAB_TEXT[tab])}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage({
  api,
  me,
  role,
  workspaceId,
  workspaceName,
  billing,
  waiting,
  emailAvailable,
  onLeft,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  /** The owner's billing state on the cloud plan, and null otherwise. */
  billing: BillingState | null;
  /** The workspace waits for the cloud to open, so its widget is off. */
  waiting: boolean;
  /** The server sends email, so invites go by email. */
  emailAvailable: boolean;
  onLeft(): void;
}) {
  const team = useTeam(api, role);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsFailure, setSettingsFailure] = useState<TextId | null>(null);
  const [picked, setPicked] = useState<Tab>("team");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (role === "member") return;
    let current = true;
    setSettingsFailure(null);
    api.settings().then(
      (next) => {
        if (current) setSettings(next);
      },
      (failure: unknown) => {
        if (current) setSettingsFailure(failureText(failure, {}, "actionFailed"));
      },
    );
    return () => {
      current = false;
    };
  }, [api, role]);

  const counted = settings?.usage ?? null;
  // The plan's limit counts pending invites as operators, so the bar and the line count them too.
  const usage =
    counted === null
      ? null
      : {
          ...counted,
          operators: {
            ...counted.operators,
            used: counted.operators.used + team.invites.length,
          },
        };
  const tabs: Tab[] = ["team"];
  if (settings !== null) tabs.push("install", "sites", "secret", "api");
  if (role === "owner" || team.blocked.length > 0) tabs.push("data");
  const tab = tabs.includes(picked) ? picked : "team";

  return (
    <Page
      title={t("settings")}
      context={settingsContext(workspaceName, usage, team.members.length)}
      // The invite button belongs to the team, so only its tab shows it. The line above stays on
      // every tab, so the tabs do not move when one is picked.
      actions={
        role === "member" || tab !== "team" ? undefined : (
          <button type="button" className="pill dark invite" onClick={() => setInviting(true)}>
            <Icon name="plusBold" size={14} />
            {/* On a phone the short label keeps the button in the title row. */}
            <span className="invite-long">{t("invitesTitle")}</span>
            <span className="invite-short" aria-hidden="true">
              {t("inviteShort")}
            </span>
          </button>
        )
      }
    >
      <Tabs tabs={tabs} current={tab} onPick={setPicked} />
      <div className="tab-panel" id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {settings === null && tab === "team" && <ErrorNote text={settingsFailure} />}
        {tab === "team" && (
          <TeamTab
            api={api}
            me={me}
            role={role}
            team={team}
            usage={usage}
            billing={billing}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            onLeft={onLeft}
          />
        )}
        {tab === "install" && settings !== null && (
          <>
            <SnippetRow publicKey={settings.publicKey} waiting={waiting} />
            <WidgetTextsRow api={api} settings={settings} onSaved={setSettings} />
          </>
        )}
        {tab === "sites" && settings !== null && (
          <OriginsRow api={api} settings={settings} onSaved={setSettings} />
        )}
        {tab === "secret" && settings !== null && (
          <SecretRow api={api} settings={settings} onSaved={setSettings} />
        )}
        {tab === "api" && settings !== null && (
          <>
            <ApiKeysRow api={api} />
            <WebhooksRow api={api} />
          </>
        )}
        {tab === "data" && (
          <>
            {role === "owner" && (
              <PageRow title={t("exportTitle")} help={t("exportHelp")}>
                <a className="pill" href={api.exportUrl} download>
                  {t("exportDownload")}
                </a>
              </PageRow>
            )}
            {team.blocked.length > 0 && <BlockedRow api={api} team={team} />}
            {role === "owner" && (
              <DeleteRow api={api} name={workspaceName} cloud={me.billing} onDeleted={onLeft} />
            )}
          </>
        )}
      </div>
      {inviting && (
        <InviteDialog
          api={api}
          role={role}
          emailAvailable={emailAvailable}
          onClose={() => {
            setInviting(false);
            team.load();
          }}
        />
      )}
    </Page>
  );
}

/** The owner deletes the workspace by typing its name, in a dialog. */
function DeleteRow({
  api,
  name,
  cloud,
  onDeleted,
}: {
  api: WorkspaceApi;
  name: string;
  cloud: boolean;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.deleteWorkspace(typed.trim());
      onDeleted();
    } catch (failure) {
      setBusy(false);
      setError(
        failureText(
          failure,
          { 400: "deleteWorkspaceFailed", 429: "tooManyAttempts" },
          "deleteWorkspaceFailed",
        ),
      );
    }
  };
  const help = cloud
    ? `${t("deleteWorkspaceHelp")} ${t("deleteWorkspaceCloud")}`
    : t("deleteWorkspaceHelp");
  return (
    <PageRow title={t("deleteWorkspaceTitle")} help={help} danger>
      {/* An outline, as for replacing the secret. The filled red is for the confirm step. */}
      <button
        type="button"
        className="pill danger-soft"
        onClick={() => {
          setTyped("");
          setError(null);
          setOpen(true);
        }}
      >
        {t("deleteWorkspaceOpen")}
      </button>
      {open && (
        <Confirm
          title={t("deleteWorkspaceConfirmTitle", { name })}
          text={t("deleteWorkspaceConfirm")}
          confirm={t("deleteWorkspaceButton")}
          disabled={busy || typed.trim() !== name}
          onConfirm={() => void submit()}
          onCancel={() => setOpen(false)}
        >
          <Field
            label={t("deleteWorkspaceType", { name })}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
          />
          <ErrorNote text={error} />
        </Confirm>
      )}
    </PageRow>
  );
}
