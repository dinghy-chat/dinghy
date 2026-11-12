/** @jsxImportSource react */
import { type ReactNode, useEffect, useId, useState } from "react";
import { logoSvg } from "../../../packages/widget/src/boat.ts";
import {
  type ApiKeyLevel,
  type AuthorizeInfo,
  approveApp,
  authorizeInfo,
  type ClientOrigin,
  denyApp,
  type Me,
  type ReplyMode,
} from "./api.ts";
import { LEVEL_LABEL, REPLY_MODES } from "./bots.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { Select } from "./popup.tsx";
import { AuthPage, SceneLoading, SceneLogo, useScene } from "./scene.tsx";
import { WorkspaceTile } from "./sidebar.tsx";
import { type TextId, t } from "./text.ts";
import { ErrorNote, failureText, ROLE_TEXT } from "./ui.tsx";

/** After this long on the page, the browser did not leave for the app, so the tab is done. */
const LEAVE_WAIT_MS = 1000;

type Consent = Extract<AuthorizeInfo, { kind: "consent" }>;

/**
 * The app that sent a signed-out person here, from its return address: the sign-in card names it.
 * Nothing checked the address yet, so the card names only an https address's host.
 */
export function requestingApp(query: URLSearchParams): string {
  const to = query.get("redirect_uri");
  if (to === null || !URL.canParse(to)) return t("consentAppUnknown");
  const url = new URL(to);
  return url.protocol === "https:"
    ? t("consentAppHost", { host: url.hostname })
    : t("consentAppUnknown");
}

/**
 * The one fact Dinghy checked about an app, when it tells the person something: the host that
 * published its metadata, or the website a registered app returns to. Null for an app on this
 * computer, whose loopback address or own scheme names nobody.
 */
export function originLine(origin: ClientOrigin): string | null {
  if (origin.kind === "cimd") return t("appPublishedBy", { host: origin.host });
  return origin.local ? null : t("appReturnsTo", { host: origin.host });
}

/** The card after the browser left for the app, or should have: the tab's work is done. */
function DoneCard({ title, note }: { title: TextId; note: string }) {
  return (
    <AuthPage>
      <h1>{t(title)}</h1>
      <p className="note">{note}</p>
    </AuthPage>
  );
}

/** A calm card for a request that cannot go on, with a way into the app. */
function Refused({ text }: { text: TextId }) {
  return (
    <AuthPage>
      <h1>{t("consentRefusedTitle")}</h1>
      <p className="note">{t(text)}</p>
      <button type="button" className="btn primary large" onClick={() => navigate("/")}>
        {t("openApp")}
      </button>
    </AuthPage>
  );
}

/**
 * Sends the browser back to the app. A loopback or app address may leave the tab where it is, so
 * after a second the card says the tab can close.
 */
function useLeave(): [done: TextId | null, leave: (to: string, done: TextId) => void] {
  const [done, setDone] = useState<TextId | null>(null);
  const leave = (to: string, text: TextId) => {
    location.assign(to);
    setTimeout(() => setDone(text), LEAVE_WAIT_MS);
  };
  return [done, leave];
}

/** The words of each access level's card: who it is for, what it can do, and what it can't. */
const LEVEL_CARDS: Record<ApiKeyLevel, { for: TextId; can: TextId[]; cannot?: TextId }> = {
  conversations: {
    for: "levelChatsFor",
    can: ["levelChatsCanAnswer", "levelChatsCanManage", "levelChatsCanNotes", "levelChatsCanSee"],
  },
  setup: {
    for: "levelFullFor",
    can: ["levelFullCanChats", "levelFullCanInstall", "levelFullCanLook", "levelFullCanWebhooks"],
    cannot: "levelFullCannot",
  },
};
const LEVELS: ApiKeyLevel[] = ["conversations", "setup"];
const REPLY_HELP: Record<ReplyMode, TextId> = {
  draft: "replyModeDraftHelp",
  send: "replyModeSendHelp",
};

/** A choice drawn as cards side by side, each a radio button for the keys and screen readers. */
function OptionCards<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; title: string; tag?: string; children: ReactNode }[];
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <fieldset className="consent-field">
      <legend className="field-label">{label}</legend>
      <div className="opts">
        {options.map((option) => (
          <label key={option.value} className="opt">
            <span className="opt-top">
              <input
                type="radio"
                name={name}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <b>{option.title}</b>
              {option.tag !== undefined && <span className="tag">{option.tag}</span>}
            </span>
            {option.children}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LevelCard({ level }: { level: ApiKeyLevel }) {
  const card = LEVEL_CARDS[level];
  return (
    <>
      <span className="opt-text">{t(card.for)}</span>
      <ul className="can">
        {card.can.map((id) => (
          <li key={id} className="can-item">
            <Icon name="checkThin" size={14} />
            {t(id)}
          </li>
        ))}
        {card.cannot !== undefined && (
          <li className="can-item cannot">
            <Icon name="close" size={14} />
            {t(card.cannot)}
          </li>
        )}
      </ul>
    </>
  );
}

function ConsentForm({ request, consent, me }: { request: string; consent: Consent; me: Me }) {
  const [workspaceId, setWorkspaceId] = useState(consent.workspaces[0]?.id ?? "");
  const [level, setLevel] = useState<ApiKeyLevel>(consent.level);
  const [replyMode, setReplyMode] = useState<ReplyMode>("draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [done, leave] = useLeave();
  useScene();
  const answer = async (send: () => Promise<{ redirectTo: string }>, text: TextId) => {
    setBusy(true);
    setError(null);
    try {
      leave((await send()).redirectTo, text);
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, { 400: "consentExpired", 403: "consentNotAdmin" }));
    }
  };
  const { client, workspaces } = consent;
  if (done !== null) {
    const note =
      done === "consentDone" ? t("consentGoBack", { app: client.name }) : t("consentCloseTab");
    return <DoneCard title={done} note={note} />;
  }
  const canApprove = workspaces.length > 0;
  const origin = originLine(client);
  return (
    <main className="signin consent-main">
      <div className="consent">
        <div className="consent-about">
          <SceneLogo />
          <div className="link-visual" aria-hidden="true">
            <span className="app-tile client">
              <Icon name="terminal" size={30} />
            </span>
            <span className="link-line">
              <span>
                <Icon name="lock" size={14} />
              </span>
            </span>
            <span
              className="app-tile dinghy"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from boat.ts.
              dangerouslySetInnerHTML={{ __html: logoSvg(40) }}
            />
          </div>
          <div>
            {/* The app's name stays on one line, so "Claude Code" never breaks in two. */}
            <h1>{t("consentTitle", { name: client.name.replaceAll(" ", "\u00a0") })}</h1>
            {origin !== null && <p className="consent-origin">{origin}</p>}
            <p className="lede">{t("consentLede")}</p>
          </div>
          <p className="signed-in">
            <Icon name="user" size={15} />
            <span>
              {t("consentSignedIn")} <b>{me.name}</b>
            </span>
          </p>
        </div>
        <div className="consent-choices">
          {canApprove ? (
            <ConsentChoices
              me={me}
              workspaces={workspaces}
              workspaceId={workspaceId}
              level={level}
              replyMode={replyMode}
              onWorkspace={setWorkspaceId}
              onLevel={setLevel}
              onReplyMode={setReplyMode}
            />
          ) : (
            <p className="note">{t("consentNoWorkspace")}</p>
          )}
          <ErrorNote text={error} />
          <div className="consent-actions">
            {canApprove && (
              <button
                type="button"
                className="btn primary large"
                disabled={busy}
                onClick={() =>
                  void answer(
                    () => approveApp(workspaceId, { request, level, replyMode }),
                    "consentDone",
                  )
                }
              >
                {t("consentApprove")}
              </button>
            )}
            <button
              type="button"
              className="btn large quiet"
              disabled={busy}
              onClick={() => void answer(() => denyApp(request), "consentCancelled")}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function ConsentChoices({
  me,
  workspaces,
  workspaceId,
  level,
  replyMode,
  onWorkspace,
  onLevel,
  onReplyMode,
}: {
  me: Me;
  workspaces: Consent["workspaces"];
  workspaceId: string;
  level: ApiKeyLevel;
  replyMode: ReplyMode;
  onWorkspace(id: string): void;
  onLevel(level: ApiKeyLevel): void;
  onReplyMode(mode: ReplyMode): void;
}) {
  const membership = (id: string) => me.workspaces.find((one) => one.workspaceId === id);
  return (
    <>
      <div className="consent-field">
        {/* The control's own label names it for screen readers. */}
        <span className="field-label" aria-hidden="true">
          {t("consentWorkspace")}
        </span>
        <Select
          label={t("consentWorkspace")}
          className="consent-workspace"
          value={workspaceId}
          choices={workspaces.map((one) => {
            const role = membership(one.id)?.role;
            return {
              value: one.id,
              label: one.name,
              lead: <WorkspaceTile name={one.name} logoUrl={membership(one.id)?.logoUrl ?? null} />,
              ...(role === undefined ? {} : { note: t(ROLE_TEXT[role]) }),
            };
          })}
          onChange={onWorkspace}
        />
      </div>
      <OptionCards<ApiKeyLevel>
        label={t("apiKeyLevel")}
        value={level}
        options={LEVELS.map((one) => ({
          value: one,
          title: t(LEVEL_LABEL[one]),
          children: <LevelCard level={one} />,
        }))}
        onChange={onLevel}
      />
      <OptionCards<ReplyMode>
        label={t("replyMode")}
        value={replyMode}
        options={REPLY_MODES.map((mode) => ({
          value: mode.value,
          title: t(mode.label),
          ...(mode.value === "draft" ? { tag: t("recommended") } : {}),
          children: <span className="opt-text">{t(REPLY_HELP[mode.value])}</span>,
        }))}
        onChange={onReplyMode}
      />
    </>
  );
}

/** A request that is not valid, but names a safe address: the browser goes back with the error. */
function Returning({ to }: { to: string }) {
  const [done, leave] = useLeave();
  // biome-ignore lint/correctness/useExhaustiveDependencies: it leaves once, for this address.
  useEffect(() => leave(to, "consentReturned"), [to]);
  if (done === null) return <SceneLoading />;
  return <DoneCard title={done} note={t("consentCloseTab")} />;
}

/** The page an app sends an owner or admin to, at /oauth/authorize, to connect it to a workspace. */
export function ConsentPage({ request, me }: { request: string; me: Me }) {
  const info = useLoad(() => authorizeInfo(request), [request]);
  // An unknown app or return address: the browser must never go back to it.
  if (info.failure !== null) return <Refused text={info.failure} />;
  if (info.data === null) return <SceneLoading />;
  if (info.data.kind === "redirect") return <Returning to={info.data.redirectTo} />;
  return <ConsentForm request={request} consent={info.data} me={me} />;
}
