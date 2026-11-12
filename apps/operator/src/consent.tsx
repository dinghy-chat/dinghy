/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  type ApiKeyLevel,
  type AuthorizeInfo,
  approveApp,
  authorizeInfo,
  denyApp,
  type ReplyMode,
} from "./api.ts";
import { LevelChoice, ReplyModeChoice } from "./bots.tsx";
import { useLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { Select } from "./popup.tsx";
import { AuthPage, SceneLoading } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { ErrorNote, failureText } from "./ui.tsx";

/** After this long on the page, the browser did not leave for the app, so the tab is done. */
const LEAVE_WAIT_MS = 1000;

type Consent = Extract<AuthorizeInfo, { kind: "consent" }>;

/**
 * The hosts of an app on the operator's own computer, as the server names them. The server tells
 * the key list which keys are loopback, but this page reads an address that nothing checked yet.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Who asks, as the headline says it: the host the browser returns to, never the app's own name. */
function headline({ client }: Consent): string {
  if (client.kind === "cimd")
    return t("consentTitleNamed", { name: client.name, host: client.host });
  return client.loopback ? t("consentTitleLoopback") : t("consentTitleHost", { host: client.host });
}

/**
 * The app that sent a signed-out person here, from its return address: the sign-in card names it.
 * Nothing checked the address yet, so the card names only its host.
 */
export function requestingApp(query: URLSearchParams): string {
  const to = query.get("redirect_uri");
  if (to === null || !URL.canParse(to)) return t("consentAppUnknown");
  const url = new URL(to);
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return t("consentAppLoopback");
  return url.protocol === "https:"
    ? t("consentAppHost", { host: url.hostname })
    : t("consentAppUnknown");
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

function ConsentForm({ request, consent }: { request: string; consent: Consent }) {
  const [workspaceId, setWorkspaceId] = useState(consent.workspaces[0]?.id ?? "");
  const [level, setLevel] = useState<ApiKeyLevel>(consent.level);
  const [replyMode, setReplyMode] = useState<ReplyMode>("draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [done, leave] = useLeave();
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
  return (
    <AuthPage>
      <h1>{headline(consent)}</h1>
      {client.kind === "dcr" && (
        <p className="consent-client">
          {t("consentCallsItself", { name: client.name })}{" "}
          <span className="chip warn">{t("unverifiedApp")}</span>
        </p>
      )}
      {canApprove ? (
        <ConsentChoices
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
      {canApprove && (
        <button
          type="button"
          className="btn primary large"
          disabled={busy}
          onClick={() =>
            void answer(() => approveApp(workspaceId, { request, level, replyMode }), "consentDone")
          }
        >
          {t("consentApprove")}
        </button>
      )}
      <button
        type="button"
        className="btn outline large"
        disabled={busy}
        onClick={() => void answer(() => denyApp(request), "consentCancelled")}
      >
        {t("cancel")}
      </button>
    </AuthPage>
  );
}

function ConsentChoices({
  workspaces,
  workspaceId,
  level,
  replyMode,
  onWorkspace,
  onLevel,
  onReplyMode,
}: {
  workspaces: Consent["workspaces"];
  workspaceId: string;
  level: ApiKeyLevel;
  replyMode: ReplyMode;
  onWorkspace(id: string): void;
  onLevel(level: ApiKeyLevel): void;
  onReplyMode(mode: ReplyMode): void;
}) {
  return (
    <>
      <div className="consent-choice">
        {/* The control's own label names it for screen readers. */}
        <span className="setting-label" aria-hidden="true">
          {t("consentWorkspace")}
        </span>
        {workspaces.length === 1 ? (
          <strong className="consent-workspace">{workspaces[0]?.name}</strong>
        ) : (
          <Select
            label={t("consentWorkspace")}
            value={workspaceId}
            choices={workspaces.map((one) => ({ value: one.id, label: one.name }))}
            onChange={onWorkspace}
          />
        )}
      </div>
      <LevelChoice className="consent-choice" full value={level} onChange={onLevel}>
        {level === "setup" && <p className="hint">{t("consentSetupNote")}</p>}
      </LevelChoice>
      <ReplyModeChoice className="consent-choice" full value={replyMode} onChange={onReplyMode} />
      <p className="note">{t("consentRevokeNote")}</p>
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
export function ConsentPage({ request }: { request: string }) {
  const info = useLoad(() => authorizeInfo(request), [request]);
  // An unknown app or return address: the browser must never go back to it.
  if (info.failure !== null) return <Refused text={info.failure} />;
  if (info.data === null) return <SceneLoading />;
  if (info.data.kind === "redirect") return <Returning to={info.data.redirectTo} />;
  return <ConsentForm request={request} consent={info.data} />;
}
