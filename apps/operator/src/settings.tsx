/** @jsxImportSource react */
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BillingRow } from "../../../ee/operator/billing.tsx";
import {
  type BillingState,
  type BlockedVisitor,
  type Me,
  type Member,
  type PendingInvite,
  type Role,
  type Usage,
  updateName,
  type WorkspaceApi,
  type WorkspaceSettings,
} from "./api.ts";
import { type TextId, t } from "./text.ts";
import { ErrorNote, Field, failureText, Page, PageRow, ROLE_TEXT, StatusNote } from "./ui.tsx";
import { visitorName } from "./visitor.ts";

const teamFailure = (failure: unknown) => failureText(failure, { 409: "lastOwner" });

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn light small"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        })
      }
    >
      {done ? t("copied") : t("copy")}
    </button>
  );
}

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
        <p>{t("snippetWaiting")}</p>
      </PageRow>
    );
  }
  const snippet = `<script src="${location.origin}/widget/loader.js" data-key="${publicKey}" async></script>`;
  return (
    <PageRow title={t("snippetTitle")} help={t("snippetHelp")}>
      <CodeBlock value={snippet} />
    </PageRow>
  );
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
  const [origins, setOrigins] = useState(settings.allowedOrigins.join("\n"));
  const [note, setNote] = useState<TextId | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const list = origins
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    try {
      const saved = await api.setOrigins(list);
      onSaved(saved);
      setOrigins(saved.allowedOrigins.join("\n"));
      setNote("originsSaved");
    } catch (failure) {
      setNote(failureText(failure, { 400: "originsBad" }));
    }
  };

  return (
    <PageRow title={<label htmlFor="origins">{t("originsTitle")}</label>} help={t("originsHelp")}>
      <form className="stack" onSubmit={save}>
        <textarea
          id="origins"
          rows={3}
          value={origins}
          onChange={(event) => {
            setOrigins(event.target.value);
            setNote(null);
          }}
        />
        <div className="actions">
          <button type="submit" className="btn navy small">
            {t("originsSave")}
          </button>
        </div>
        <StatusNote text={note} />
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
  const [error, setError] = useState<TextId | null>(null);
  const rotate = async () => {
    setError(null);
    try {
      onSaved(await api.rotateSecret());
      setShown(true);
      setConfirming(false);
    } catch (failure) {
      setError(failureText(failure, {}));
    }
  };
  return (
    <PageRow title={t("secretTitle")} help={t("secretHelp")}>
      {shown && <CodeBlock value={settings.signingSecret} />}
      <div className="actions">
        <button
          type="button"
          className="btn outline small"
          onClick={() => setShown((current) => !current)}
        >
          {shown ? t("secretHide") : t("secretShow")}
        </button>
        <button type="button" className="btn outline small" onClick={() => setConfirming(true)}>
          {t("secretRotate")}
        </button>
      </div>
      {confirming && (
        <div className="confirm" role="alert">
          <p>{t("secretWarning")}</p>
          <button type="button" className="btn danger small" onClick={() => void rotate()}>
            {t("secretConfirm")}
          </button>
          <ErrorNote text={error} />
        </div>
      )}
    </PageRow>
  );
}

/** The operator's own name. Every role has this. */
function AccountRow({ me, onChanged }: { me: Me; onChanged(): void }) {
  const [name, setName] = useState(me.name);
  const [nameNote, setNameNote] = useState<{ ok: boolean; text: TextId } | null>(null);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await updateName(name.trim());
      setName(name.trim());
      setNameNote({ ok: true, text: "accountNameSaved" });
      onChanged();
    } catch (failure) {
      setNameNote({ ok: false, text: failureText(failure, {}) });
    }
  };

  return (
    <PageRow title={t("accountTitle")} help={t("accountHelp")}>
      <form className="stack" onSubmit={saveName}>
        <Field
          label={t("accountName")}
          value={name}
          onChange={(value) => {
            setName(value);
            setNameNote(null);
          }}
          required
          maxLength={100}
          autoComplete="name"
        />
        <div className="actions">
          <button type="submit" className="btn navy small" disabled={name.trim() === ""}>
            {t("accountNameSave")}
          </button>
        </div>
        {nameNote?.ok === true && <StatusNote text={nameNote.text} />}
        {nameNote?.ok === false && <ErrorNote text={nameNote.text} />}
      </form>
    </PageRow>
  );
}

/** Team, blocked visitors and invites load together, and any change to one reloads them all. */
function useTeam(api: WorkspaceApi, role: Role) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [blocked, setBlocked] = useState<BlockedVisitor[]>([]);
  const [moreBlocked, setMoreBlocked] = useState(false);
  const [note, setNote] = useState<TextId | null>(null);

  // Each load counts up, so an answer from an older load cannot overwrite a newer one.
  const loads = useRef(0);
  const load = useCallback(() => {
    const id = ++loads.current;
    const apply =
      <T,>(set: (value: T) => void) =>
      (value: T) => {
        if (id === loads.current) set(value);
      };
    const failed = apply((failure: unknown) => setNote(teamFailure(failure)));
    api.members().then(
      apply((page) => setMembers(page.members)),
      failed,
    );
    api.blockedVisitors(0).then(
      apply((page) => {
        setBlocked(page.visitors);
        setMoreBlocked(page.hasMore);
      }),
      failed,
    );
    if (role !== "agent") {
      api.invites().then(
        apply((page) => setInvites(page.invites)),
        failed,
      );
    }
  }, [api, role]);
  useEffect(() => {
    load();
    return () => {
      // A later answer is for a page that is gone.
      loads.current += 1;
    };
  }, [load]);

  const loadingBlocked = useRef(false);
  const loadMoreBlocked = async () => {
    // A ref, because two quick clicks can both run before a render. A second page request from the
    // same offset would add duplicates, and the list would then count past the end.
    if (loadingBlocked.current) return;
    loadingBlocked.current = true;
    try {
      const page = await api.blockedVisitors(blocked.length);
      setBlocked((current) => [...current, ...page.visitors]);
      setMoreBlocked(page.hasMore);
    } catch (failure) {
      setNote(teamFailure(failure));
    } finally {
      loadingBlocked.current = false;
    }
  };

  const act = async (work: Promise<unknown>) => {
    setNote(null);
    try {
      await work;
    } catch (failure) {
      setNote(teamFailure(failure));
    }
    load();
  };

  return { members, invites, blocked, moreBlocked, note, setNote, load, loadMoreBlocked, act };
}

type Team = ReturnType<typeof useTeam>;

function TeamRow({
  api,
  me,
  role,
  team,
  onLeft,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  team: Team;
  onLeft(): void;
}) {
  return (
    <PageRow title={t("teamTitle")}>
      <ul className="team">
        {team.members.map((member) => (
          <li key={member.id}>
            <span>
              <strong>{member.name}</strong> {member.email}
            </span>
            {role === "owner" ? (
              <select
                aria-label={`${t("roleLabel")}: ${member.name}`}
                value={member.role}
                onChange={(event) =>
                  void team.act(api.setRole(member.id, event.target.value as Role))
                }
              >
                {(["owner", "admin", "agent"] as const).map((one) => (
                  <option key={one} value={one}>
                    {t(ROLE_TEXT[one])}
                  </option>
                ))}
              </select>
            ) : (
              <span className="pill">{t(ROLE_TEXT[member.role])}</span>
            )}
            {member.id === me.id ? (
              <button
                type="button"
                className="btn link small"
                onClick={() =>
                  void api
                    .removeMember(member.id)
                    .then(onLeft, (failure: unknown) => team.setNote(teamFailure(failure)))
                }
              >
                {t("leaveWorkspace")}
              </button>
            ) : (
              (role === "owner" || (role === "admin" && member.role === "agent")) && (
                <button
                  type="button"
                  className="btn link small"
                  aria-label={`${t("removeMember")}: ${member.name}`}
                  onClick={() => void team.act(api.removeMember(member.id))}
                >
                  {t("removeMember")}
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      <ErrorNote text={team.note} />
    </PageRow>
  );
}

function BlockedRow({ api, team }: { api: WorkspaceApi; team: Team }) {
  return (
    <PageRow title={t("blockedTitle")}>
      <ul className="team">
        {team.blocked.map((person) => (
          <li key={person.id}>
            <span>
              {visitorName(person)}. {t("blockedSince")}{" "}
              {new Date(person.blockedAt).toLocaleDateString()}
            </span>
            <button
              type="button"
              className="btn outline small"
              onClick={() => void team.act(api.unblockVisitor(person.id))}
            >
              {t("unblockVisitor")}
            </button>
          </li>
        ))}
      </ul>
      {team.moreBlocked && (
        <button
          type="button"
          className="btn link small"
          onClick={() => void team.loadMoreBlocked()}
        >
          {t("loadMore")}
        </button>
      )}
    </PageRow>
  );
}

/** Bytes in the decimal units the plan uses, such as 12.3 MB or 1 GB. */
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${Number((bytes / 1e9).toFixed(2))} GB`;
  return `${Number((bytes / 1e6).toFixed(1))} MB`;
}

/** The plan's limits and how much of each is used, on Dinghy Cloud. */
function UsageRow({ usage }: { usage: Usage }) {
  const fill = (id: TextId, used: string, limit: string) =>
    t(id).replace("{used}", used).replace("{limit}", limit);
  return (
    <PageRow title={t("usageTitle")} help={t("usageHelp")}>
      <ul className="team">
        <li>
          {fill("usageOperators", String(usage.operators.used), String(usage.operators.limit))}
        </li>
        <li>
          {fill(
            "usageImages",
            formatBytes(usage.imageBytes.used),
            formatBytes(usage.imageBytes.limit),
          )}
        </li>
      </ul>
    </PageRow>
  );
}

function InviteRow({ api, role, team }: { api: WorkspaceApi; role: Role; team: Team }) {
  const [inviteRole, setInviteRole] = useState<"admin" | "agent">("agent");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<TextId | null>(null);

  const createLink = async () => {
    setError(null);
    try {
      const created = await api.createInvite(inviteRole);
      setLink(new URL(`/invite?token=${encodeURIComponent(created.token)}`, location.origin).href);
    } catch (failure) {
      setLink(null);
      setError(failureText(failure, {}));
    }
    team.load();
  };

  return (
    <PageRow title={t("invitesTitle")} help={t("inviteHelp")}>
      <div className="actions">
        {role === "owner" && (
          <select
            aria-label={t("roleLabel")}
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as "admin" | "agent")}
          >
            <option value="agent">{t("roleAgent")}</option>
            <option value="admin">{t("roleAdmin")}</option>
          </select>
        )}
        <button type="button" className="btn primary" onClick={() => void createLink()}>
          {t("inviteCreate")}
        </button>
      </div>
      <ErrorNote text={error} />
      {link !== null && (
        <>
          <p className="hint">{t("inviteLink")}</p>
          <CodeBlock value={link} />
        </>
      )}
      <ul className="team">
        {team.invites.map((pending) => (
          <li key={pending.id}>
            <span>
              {t(ROLE_TEXT[pending.role])}. {t("inviteExpires")}{" "}
              {new Date(pending.expiresAt).toLocaleDateString()}
            </span>
            <button
              type="button"
              className="btn outline small"
              onClick={() => void team.act(api.revokeInvite(pending.id))}
            >
              {t("inviteRevoke")}
            </button>
          </li>
        ))}
      </ul>
    </PageRow>
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
  onLeft,
  onAccountChanged,
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
  onLeft(): void;
  onAccountChanged(): void;
}) {
  const manages = role !== "agent";
  const team = useTeam(api, role);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsFailure, setSettingsFailure] = useState<TextId | null>(null);

  useEffect(() => {
    if (role === "agent") return;
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

  return (
    <Page title={t("settings")}>
      <AccountRow me={me} onChanged={onAccountChanged} />
      {settings === null && <ErrorNote text={settingsFailure} />}
      {settings !== null && (
        <>
          <SnippetRow publicKey={settings.publicKey} waiting={waiting} />
          <OriginsRow api={api} settings={settings} onSaved={setSettings} />
          <SecretRow api={api} settings={settings} onSaved={setSettings} />
          {settings.usage !== null && <UsageRow usage={settings.usage} />}
        </>
      )}
      <TeamRow api={api} me={me} role={role} team={team} onLeft={onLeft} />
      {role === "owner" && <BillingRow api={api} workspaceId={workspaceId} billing={billing} />}
      {role === "owner" && (
        <PageRow title={t("exportTitle")} help={t("exportHelp")}>
          <a className="btn primary" href={api.exportUrl} download>
            {t("exportDownload")}
          </a>
        </PageRow>
      )}
      {team.blocked.length > 0 && <BlockedRow api={api} team={team} />}
      {manages && <InviteRow api={api} role={role} team={team} />}
      {role === "owner" && (
        <DeleteRow api={api} name={workspaceName} onDeleted={() => location.assign("/")} />
      )}
    </Page>
  );
}

/** The owner deletes the workspace by typing its name. */
function DeleteRow({
  api,
  name,
  onDeleted,
}: {
  api: WorkspaceApi;
  name: string;
  onDeleted(): void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
  return (
    <PageRow title={t("deleteWorkspaceTitle")} help={t("deleteWorkspaceHelp")}>
      <form className="stack" onSubmit={submit}>
        <Field
          label={t("deleteWorkspaceType").replace("{name}", name)}
          value={typed}
          onChange={setTyped}
          autoComplete="off"
        />
        <div className="actions">
          <button
            type="submit"
            className="btn danger small"
            disabled={busy || typed.trim() !== name}
          >
            {t("deleteWorkspaceButton")}
          </button>
        </div>
        <ErrorNote text={error} />
      </form>
    </PageRow>
  );
}
