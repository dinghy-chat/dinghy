/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type CodeLanguage, highlight } from "../../../packages/widget/src/highlight.ts";
import {
  type BillingState,
  type Me,
  type Role,
  removePicture,
  requestAccountDelete,
  setPicture,
  type Usage,
  updateName,
  type WorkspaceApi,
  type WorkspaceSettings,
} from "./api.ts";
import { ApiKeysRow, WebhooksRow } from "./integrations.tsx";
import { leave, navigate } from "./nav.ts";
import { Confirm } from "./popup.tsx";
import { BlockedRow, InviteDialog, imagesText, operatorsText, TeamTab, useTeam } from "./team.tsx";
import { type TextId, t } from "./text.ts";
import { savedTheme, setTheme, type Theme } from "./theme.ts";
import {
  CopyButton,
  CopyText,
  ErrorNote,
  Field,
  failureText,
  Icon,
  type IconName,
  ImageUpload,
  type Note,
  Page,
  PageRow,
  SaveNote,
  StatusNote,
  type UploadText,
} from "./ui.tsx";
import { WidgetTab } from "./widget-tab.tsx";

const PICTURE_TEXT: UploadText = {
  upload: "pictureUpload",
  replace: "pictureReplace",
  remove: "pictureRemove",
  preview: "picturePreview",
  tooLarge: "pictureTooLarge",
};

/** The code's lines as text and colored spans. Each span's key is where it starts in the code. */
function codeNodes(value: string, language: CodeLanguage): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  highlight(value, language).forEach((line, index) => {
    if (index > 0) {
      nodes.push("\n");
      at += 1;
    }
    for (const { kind, text } of line.tokens) {
      nodes.push(
        kind === null ? (
          text
        ) : (
          <span key={at} className={`code-${kind}`}>
            {text}
          </span>
        ),
      );
      at += text.length;
    }
  });
  return nodes;
}

/** Code to paste, colored as in the docs. Copy copies the exact text. */
function CodeBlock({
  value,
  language,
  title,
}: {
  value: string;
  language: CodeLanguage;
  title: string;
}) {
  return (
    <div className="code-block">
      <div className="code-bar">
        <span>{title}</span>
        <CopyButton value={value} />
      </div>
      <pre>
        <code>{codeNodes(value, language)}</code>
      </pre>
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
  // One line, as a developer pastes it. It scrolls sideways in its box instead of breaking.
  const snippet = `<script src="${location.origin}/widget/loader.js" data-key="${publicKey}" async></script>`;
  return (
    <PageRow title={t("snippetTitle")} help={t("snippetHelp")}>
      <CodeBlock value={snippet} language="html" title={t("codeHtml")} />
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

/** Where the account's delete sends a sole owner: a workspace's Team tab or its delete dialog. */
export type OwnerStep = "team" | "delete";

/** Opens another workspace on its Team tab or its delete dialog. */
export const openOwnerStep = (workspaceId: string, step: OwnerStep) =>
  navigate(`/?workspace=${workspaceId}&settings=${step}`);

/** The step that `openOwnerStep` put in the address for this workspace, or null. */
export function ownerStepIn(workspaceId: string): OwnerStep | null {
  const params = new URLSearchParams(location.search);
  if (params.get("workspace") !== workspaceId) return null;
  const step = params.get("settings");
  return step === "team" || step === "delete" ? step : null;
}

/**
 * The field a delete waits for. The value to type sits in the label, where it copies itself, and
 * the text names its place, so each language puts it where its grammar needs it.
 */
function TypeToConfirm({
  text,
  value,
  typed,
  onChange,
  type,
}: {
  /** A sentence with one placeholder, such as "Type {name} to confirm". */
  text: TextId;
  value: string;
  typed: string;
  onChange(typed: string): void;
  type?: "email";
}) {
  const [before, after = ""] = t(text).split(/\{\w+\}/);
  return (
    <Field
      label={
        <>
          {before}
          <CopyText value={value} />
          {after}
        </>
      }
      type={type}
      value={typed}
      onChange={onChange}
      autoComplete="off"
    />
  );
}

/**
 * The operator deletes their account, once no workspace would be left without an owner. The
 * Profile page shows it, and so does every screen an operator can land on without a workspace.
 */
export function DeleteAccount({
  me,
  emailAvailable,
  keepsLastWorkspace,
  onOpen,
  onDeleted,
}: {
  me: Me;
  /** The server sends email, so a link confirms. Without, the operator types their email. */
  emailAvailable: boolean;
  /** A self-hosted server, which keeps its last workspace. */
  keepsLastWorkspace: boolean;
  onOpen(workspaceId: string, step: OwnerStep): void;
  onDeleted(): void;
}) {
  const blockers = me.workspaces.filter((one) => one.soleOwner);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const { deleted } = await requestAccountDelete(emailAvailable ? undefined : typed.trim());
      if (deleted) {
        onDeleted();
        return;
      }
      setSent(true);
    } catch (failure) {
      setError(failureText(failure, { 400: "deleteAccountFailed" }, "deleteAccountFailed"));
    }
    setBusy(false);
  };
  const matches = typed.trim().toLowerCase() === me.email.toLowerCase();
  const blockedId = useId();
  const isBlocked = blockers.length > 0;
  return (
    <>
      {isBlocked && (
        <div className="blockers">
          <p className="blockers-warning" id={blockedId}>
            <Icon name="warning" size={18} />
            {t("deleteAccountBlocked")}
          </p>
          <ul className="blocker-list">
            {blockers.map((one) => (
              <li key={one.workspaceId}>
                <span className="blocker-name">
                  <b>{one.name}</b>
                  <span className="chip">{t("deleteAccountOnlyOwner")}</span>
                </span>
                <span className="actions">
                  {/* A workspace that waits for payment has no Team tab until it is paid. */}
                  {(one.active || one.waiting) && (
                    <button
                      type="button"
                      className="pill small"
                      onClick={() => onOpen(one.workspaceId, "team")}
                    >
                      {t("deleteAccountMakeOwner")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="pill small danger-soft"
                    onClick={() => onOpen(one.workspaceId, "delete")}
                  >
                    {t("deleteAccountWorkspace")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {keepsLastWorkspace && <p className="hint">{t("deleteAccountOnlyServer")}</p>}
        </div>
      )}
      <button
        type="button"
        className="pill danger-soft"
        disabled={isBlocked}
        aria-describedby={isBlocked ? blockedId : undefined}
        onClick={() => {
          setTyped("");
          setSent(false);
          setError(null);
          setOpen(true);
        }}
      >
        {t("deleteAccountOpen")}
      </button>
      {open && (
        <Confirm
          title={t("deleteAccountConfirmTitle")}
          text={t(emailAvailable ? "deleteAccountConfirmEmail" : "deleteAccountConfirmTyped")}
          confirm={t(emailAvailable ? "deleteAccountSend" : "deleteAccountButton")}
          disabled={busy || sent || (!emailAvailable && !matches)}
          onConfirm={() => void submit()}
          onCancel={() => setOpen(false)}
        >
          {!emailAvailable && (
            <TypeToConfirm
              text="deleteAccountType"
              value={me.email}
              typed={typed}
              onChange={setTyped}
              type="email"
            />
          )}
          {sent && (
            <p className="note" role="status">
              {t("deleteAccountSent", { email: me.email })}
            </p>
          )}
          <ErrorNote text={error} />
        </Confirm>
      )}
    </>
  );
}

export function ProfilePage({
  me,
  emailAvailable,
  keepsLastWorkspace,
  onChanged,
  onOpenWorkspace,
  onAccountDeleted,
}: {
  me: Me;
  emailAvailable: boolean;
  keepsLastWorkspace: boolean;
  onChanged(): void;
  onOpenWorkspace(workspaceId: string, step: OwnerStep): void;
  onAccountDeleted(): void;
}) {
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
        <PageRow title={t("pictureTitle")} help={t("pictureHelp")}>
          <ImageUpload
            url={me.pictureUrl}
            text={PICTURE_TEXT}
            onUpload={async (file) => {
              await setPicture(file);
              onChanged();
            }}
            onRemove={async () => {
              await removePicture();
              onChanged();
            }}
          />
        </PageRow>
        <PageRow title={t("theme")} help={t("themeHelp")}>
          <ThemeChoice />
        </PageRow>
      </form>
      {/* Outside the form, because its dialog has a form of its own. */}
      <PageRow title={t("deleteAccountTitle")} help={t("deleteAccountHelp")} danger>
        <DeleteAccount
          me={me}
          emailAvailable={emailAvailable}
          keepsLastWorkspace={keepsLastWorkspace}
          onOpen={onOpenWorkspace}
          onDeleted={onAccountDeleted}
        />
      </PageRow>
    </Page>
  );
}

export type SettingsTab =
  | "team"
  | "widget"
  | "install"
  | "sites"
  | "secret"
  | "api"
  | "webhooks"
  | "data";
type Tab = SettingsTab;

const TAB_TEXT: Record<Tab, TextId> = {
  team: "tabTeam",
  widget: "tabWidget",
  install: "tabInstall",
  sites: "originsTitle",
  secret: "secretTitle",
  api: "tabApi",
  webhooks: "tabWebhooks",
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
  initialTab = "team",
  openDelete = false,
  onLeft,
  onDeleted,
  onLogoChanged,
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
  /** The tab that opens first, such as Install from the inbox's first steps. */
  initialTab?: Tab;
  /** Opens the delete dialog at once, for the account's delete. */
  openDelete?: boolean;
  onLeft(): void;
  /** The owner deleted the workspace, which had this name. */
  onDeleted(name: string): void;
  /** The logo changed, so the sidebar shows the new one. */
  onLogoChanged(logoUrl: string | null): void;
}) {
  const team = useTeam(api, role);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsFailure, setSettingsFailure] = useState<TextId | null>(null);
  const [picked, setPicked] = useState<Tab>(initialTab);
  // Only on the first visit to the Data tab: a later one shows the row, not the dialog.
  const [deleteOpening, setDeleteOpening] = useState(openDelete);
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
  // Every member reads the widget's settings. The rest are for owners and admins.
  const tabs: Tab[] = ["team", "widget"];
  if (settings !== null) tabs.push("install", "sites", "secret", "api", "webhooks");
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
      <Tabs
        tabs={tabs}
        current={tab}
        onPick={(next) => {
          if (next === tab) return;
          leave(() => {
            setPicked(next);
            setDeleteOpening(false);
          });
        }}
      />
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
        {tab === "widget" && (
          <WidgetTab api={api} me={me} canEdit={role !== "member"} onLogoChanged={onLogoChanged} />
        )}
        {tab === "install" && settings !== null && (
          <SnippetRow publicKey={settings.publicKey} waiting={waiting} />
        )}
        {tab === "sites" && settings !== null && (
          <OriginsRow api={api} settings={settings} onSaved={setSettings} />
        )}
        {tab === "secret" && settings !== null && (
          <SecretRow api={api} settings={settings} onSaved={setSettings} />
        )}
        {tab === "api" && settings !== null && <ApiKeysRow api={api} />}
        {tab === "webhooks" && settings !== null && <WebhooksRow api={api} />}
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
              <DeleteRow
                api={api}
                name={workspaceName}
                cloud={me.billing}
                deletion={settings?.deletion ?? null}
                startOpen={deleteOpening}
                onDeleted={() => onDeleted(workspaceName)}
              />
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

type Deletion = WorkspaceSettings["deletion"];

/** "312 conversations, 40 images and 3 team members are deleted for good." */
function deletionText({ conversations, images, members }: Deletion): string {
  const count = (value: number, one: TextId, many: TextId) =>
    value === 1 ? t(one) : t(many, { count: value });
  return t("deleteWorkspaceCounts", {
    conversations: count(conversations, "deleteCountConversationsOne", "deleteCountConversations"),
    images: count(images, "deleteCountImagesOne", "deleteCountImages"),
    members: count(members, "deleteCountMembersOne", "deleteCountMembers"),
  });
}

/** The owner deletes the workspace by typing its name, in a dialog. */
function DeleteRow({
  api,
  name,
  cloud,
  deletion,
  startOpen,
  onDeleted,
}: {
  api: WorkspaceApi;
  name: string;
  cloud: boolean;
  /** What the delete removes, once the settings have loaded. */
  deletion: Deletion | null;
  /** The account's delete opened this workspace to delete it. */
  startOpen: boolean;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(startOpen);
  const help = cloud
    ? `${t("deleteWorkspaceHelp")} ${t("deleteWorkspaceCloud")}`
    : t("deleteWorkspaceHelp");
  return (
    <PageRow title={t("deleteWorkspaceTitle")} help={help} danger>
      {/* An outline, as for replacing the secret. The filled red is for the confirm step. */}
      <button type="button" className="pill danger-soft" onClick={() => setOpen(true)}>
        {t("deleteWorkspaceOpen")}
      </button>
      {open && (
        <DeleteWorkspaceDialog
          api={api}
          name={name}
          cloud={cloud}
          deletion={deletion}
          exportUrl={api.exportUrl}
          onDeleted={onDeleted}
          onCancel={() => setOpen(false)}
        />
      )}
    </PageRow>
  );
}

/**
 * The dialog that deletes a workspace once its name is typed. The settings show it, and so does
 * the payment screen of a workspace that never paid, which has no counts and no export.
 */
export function DeleteWorkspaceDialog({
  api,
  name,
  cloud,
  deletion,
  exportUrl,
  onDeleted,
  onCancel,
}: {
  api: Pick<WorkspaceApi, "deleteWorkspace">;
  name: string;
  /** A paid cloud workspace, whose subscription the delete ends. */
  cloud: boolean;
  /** What the delete removes, when it is known. */
  deletion: Deletion | null;
  /** Where to download an export first, when the workspace can export. */
  exportUrl: string | null;
  onDeleted(): void;
  onCancel(): void;
}) {
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
  const only = deletion?.onlyWorkspace ?? false;
  const goes = deletion === null ? t("deleteWorkspaceConfirm") : deletionText(deletion);
  return (
    <Confirm
      title={t("deleteWorkspaceConfirmTitle", { name })}
      text={
        <>
          <p>{cloud ? `${goes} ${t("deleteWorkspaceCloud")}` : goes}</p>
          {exportUrl !== null && (
            <a className="pill small" href={exportUrl} download>
              {t("deleteWorkspaceExport")}
            </a>
          )}
        </>
      }
      confirm={t("deleteWorkspaceButton")}
      disabled={busy || only || typed.trim() !== name}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      {only ? (
        <p className="note">{t("deleteWorkspaceOnly")}</p>
      ) : (
        <TypeToConfirm text="deleteWorkspaceType" value={name} typed={typed} onChange={setTyped} />
      )}
      <ErrorNote text={error} />
    </Confirm>
  );
}
