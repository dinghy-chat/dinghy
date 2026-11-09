/** @jsxImportSource react */
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { BillingRow } from "../../../ee/operator/billing.tsx";
import { t as widgetText } from "../../../packages/widget/src/text.ts";
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
import { Confirm, Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import {
  Avatar,
  ErrorNote,
  Field,
  failureText,
  Icon,
  Page,
  PageRow,
  ROLE_TEXT,
  StatusNote,
  useModal,
} from "./ui.tsx";
import { visitorName } from "./visitor.ts";

const teamFailure = (failure: unknown) => failureText(failure, { 409: "lastOwner" });
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

function CopyButton({ value, label = t("copy") }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="pill small copy"
      aria-label={done ? t("copied") : label}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        })
      }
    >
      <Icon name={done ? "check" : "copy"} size={16} />
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
  const [note, setNote] = useState<{ ok: boolean; text: TextId } | null>(null);
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
        {note?.ok === true && <StatusNote text={note.text} />}
        {note?.ok === false && <ErrorNote text={note.text} />}
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
  const [note, setNote] = useState<{ ok: boolean; text: TextId } | null>(null);
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
        {note?.ok === true && <StatusNote text={note.text} />}
        {note?.ok === false && <ErrorNote text={note.text} />}
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
export function ProfilePage({ me, onChanged }: { me: Me; onChanged(): void }) {
  const [name, setName] = useState(me.name);
  const [note, setNote] = useState<{ ok: boolean; text: TextId } | null>(null);
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
          {note?.ok === true && <StatusNote text={note.text} />}
          {note?.ok === false && <ErrorNote text={note.text} />}
        </PageRow>
        <PageRow title={t("email")} help={t("accountEmailHelp")}>
          <input aria-label={t("email")} value={me.email} readOnly />
        </PageRow>
      </form>
    </Page>
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

const ROLES = ["owner", "admin", "agent"] as const;

/** Who is about to leave or be removed, for the dialog that asks first. */
type Leaving = { member: Member; self: boolean };

function MemberRow({
  member,
  me,
  role,
  lastOwner,
  onRole,
  onRemove,
}: {
  member: Member;
  me: Me;
  role: Role;
  /** This member is the workspace's only owner. */
  lastOwner: boolean;
  onRole(role: Role): void;
  onRemove(self: boolean): void;
}) {
  const self = member.id === me.id;
  const canRemove = self || role === "owner" || (role === "admin" && member.role === "agent");
  const removeText = self ? t("leaveWorkspace") : t("removeMember", { name: member.name });
  return (
    <tr>
      <td>
        <div className="who-cell">
          <Avatar name={member.name} />
          <span className="who-lines">
            <strong>
              {member.name}
              {self && <span className="you">{t("you")}</span>}
            </strong>
            <span className="phone-only">{member.email}</span>
          </span>
        </div>
      </td>
      <td className="email-cell">{member.email}</td>
      <td>
        {role === "owner" ? (
          <Select
            label={t("roleOf", { name: member.name })}
            value={member.role}
            className="role"
            disabled={lastOwner}
            choices={ROLES.map((one) => ({ value: one, label: t(ROLE_TEXT[one]) }))}
            onChange={onRole}
          />
        ) : (
          <span className="chip">{t(ROLE_TEXT[member.role])}</span>
        )}
      </td>
      <td className="end-cell">
        {canRemove && (
          <button
            type="button"
            className="icon-button quiet-danger"
            aria-label={removeText}
            title={self && lastOwner ? t("lastOwnerNote") : removeText}
            disabled={self && lastOwner}
            onClick={() => onRemove(self)}
          >
            <Icon name={self ? "exit" : "trash"} size={18} />
          </button>
        )}
      </td>
    </tr>
  );
}

/** Days until a date, at least one, for "Pending · 6 days left". */
const daysLeft = (iso: string) =>
  Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

function InviteRow({ pending, onRevoke }: { pending: PendingInvite; onRevoke(): void }) {
  const days = daysLeft(pending.expiresAt);
  const pendingText = t(days === 1 ? "invitePendingOne" : "invitePendingMany", {
    days: String(days),
  });
  return (
    <tr className="pending">
      <td>
        <div className="who-cell">
          <span className="avatar nobody" aria-hidden="true">
            <Icon name="link" size={16} />
          </span>
          <span className="who-lines">
            <span className="quiet">{t("inviteLinkLabel")}</span>
            {/* Under the name, since an invite link has no email. */}
            <span className="chip warn">{pendingText}</span>
          </span>
        </div>
      </td>
      <td className="email-cell" />
      <td>
        <span className="chip">{t(ROLE_TEXT[pending.role])}</span>
      </td>
      <td className="end-cell">
        <button
          type="button"
          className="text-button"
          aria-label={t("inviteRevokeLabel", {
            role: t(ROLE_TEXT[pending.role]),
            date: shortDate(pending.expiresAt),
          })}
          onClick={onRevoke}
        >
          {t("inviteRevoke")}
        </button>
      </td>
    </tr>
  );
}

/** "Invite someone": a role, then a link to copy, in a small dialog. */
function InviteDialog({ api, role, onClose }: { api: WorkspaceApi; role: Role; onClose(): void }) {
  const dialog = useModal();
  const titleId = useId();
  const [inviteRole, setInviteRole] = useState<"admin" | "agent">("agent");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);

  const createLink = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await api.createInvite(inviteRole);
      setLink(new URL(`/invite?token=${encodeURIComponent(created.token)}`, location.origin).href);
    } catch (failure) {
      setLink(null);
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId}>{t("invitesTitle")}</h2>
        <p className="dialog-text">{t("inviteHelp")}</p>
        {role === "owner" && (
          <Select<"admin" | "agent">
            label={t("inviteRole")}
            hideLabel={false}
            value={inviteRole}
            choices={[
              { value: "agent", label: t("roleAgent") },
              { value: "admin", label: t("roleAdmin") },
            ]}
            onChange={(next) => {
              setInviteRole(next);
              setLink(null);
            }}
          />
        )}
        <ErrorNote text={error} />
        {link !== null && (
          <div className="created">
            <p className="hint">{t("inviteLink")}</p>
            <div className="copy-field">
              <input
                className="mono"
                readOnly
                aria-label={t("inviteLinkLabel")}
                value={link}
                onFocus={(event) => event.target.select()}
              />
              <CopyButton value={link} label={t("inviteLinkCopy")} />
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="pill" onClick={() => dialog.current?.close()}>
            {link === null ? t("cancel") : t("done")}
          </button>
          {link === null && (
            <button
              type="button"
              className="pill dark"
              disabled={busy}
              onClick={() => void createLink()}
            >
              {t("inviteCreate")}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function TeamTab({
  api,
  me,
  role,
  team,
  usage,
  billing,
  workspaceId,
  workspaceName,
  onLeft,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  team: Team;
  usage: Usage | null;
  billing: BillingState | null;
  workspaceId: string;
  workspaceName: string;
  onLeft(): void;
}) {
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const owners = team.members.filter((member) => member.role === "owner").length;
  const lastOwner =
    owners === 1 && team.members.some((one) => one.id === me.id && one.role === "owner");
  const confirmLeave = async () => {
    if (leaving === null) return;
    const { member, self } = leaving;
    setLeaving(null);
    if (self) {
      await api.removeMember(member.id).then(onLeft, (failure: unknown) => {
        team.setNote(teamFailure(failure));
      });
    } else {
      await team.act(api.removeMember(member.id));
    }
  };
  const manages = role !== "agent";
  return (
    <>
      <table className="members">
        <thead>
          <tr>
            <th scope="col">{t("teamName")}</th>
            <th scope="col" className="email-cell">
              {t("email")}
            </th>
            <th scope="col">{t("teamRole")}</th>
            <th scope="col" className="end-cell">
              <span className="visually-hidden">{t("teamActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {team.members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              me={me}
              role={role}
              lastOwner={member.role === "owner" && owners === 1}
              onRole={(next) => void team.act(api.setRole(member.id, next))}
              onRemove={(self) => setLeaving({ member, self })}
            />
          ))}
          {manages &&
            team.invites.map((pending) => (
              <InviteRow
                key={pending.id}
                pending={pending}
                onRevoke={() => void team.act(api.revokeInvite(pending.id))}
              />
            ))}
        </tbody>
      </table>
      {lastOwner && (
        <p className="lock-note">
          <Icon name="lock" size={14} />
          {t("lastOwnerNote")}
        </p>
      )}
      <ErrorNote text={team.note} />
      {usage !== null && <PlanCards usage={usage} />}
      {role === "owner" && <BillingRow api={api} workspaceId={workspaceId} billing={billing} />}
      {leaving !== null && (
        <Confirm
          title={
            leaving.self
              ? t("leaveTitle", { workspace: workspaceName })
              : t("removeTitle", { name: leaving.member.name })
          }
          text={leaving.self ? t("leaveText") : t("removeText")}
          confirm={leaving.self ? t("leaveYes") : t("removeYes")}
          onConfirm={() => void confirmLeave()}
          onCancel={() => setLeaving(null)}
        />
      )}
    </>
  );
}

function BlockedRow({ api, team }: { api: WorkspaceApi; team: Team }) {
  return (
    <PageRow title={t("blockedTitle")} help={t("blockedHelp")}>
      <ul className="blocked">
        {team.blocked.map((person) => (
          <li key={person.id}>
            <Avatar name={visitorName(person)} />
            <span className="who-lines">
              <strong>{visitorName(person)}</strong>
              <span>{t("blockedSince", { date: shortDate(person.blockedAt) })}</span>
            </span>
            <button
              type="button"
              className="pill small"
              onClick={() => void team.act(api.unblockVisitor(person.id))}
            >
              {t("unblockVisitor")}
            </button>
          </li>
        ))}
      </ul>
      {team.moreBlocked && (
        <button type="button" className="text-button" onClick={() => void team.loadMoreBlocked()}>
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

/** How full one limit is, as a thin bar and words. Near or at the limit, both say so. */
function Meter({
  label,
  used,
  limit,
  text,
  note,
}: {
  label: string;
  used: number;
  limit: number;
  text: string;
  note: string;
}) {
  const share = limit > 0 ? Math.min(used / limit, 1) : 0;
  const level = share >= 1 ? "full" : share >= 0.8 ? "near" : "ok";
  return (
    <div className={`meter ${level}`}>
      <div className="meter-top">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{text}</span>
      </div>
      {/* The words above say the same, for screen readers too. */}
      <div className="meter-bar" aria-hidden="true">
        <span
          className="meter-fill"
          style={{ width: `${Math.max(share * 100, used > 0 ? 1.5 : 0)}%` }}
        />
      </div>
      <p className="meter-note">
        {level === "ok" ? note : t(level === "full" ? "usageFull" : "usageNear")}
      </p>
    </div>
  );
}

const operatorsText = (usage: Usage) =>
  t("usageOf", {
    used: String(usage.operators.used),
    limit: String(usage.operators.limit),
  });
const imagesText = (usage: Usage) =>
  t("usageOf", {
    used: formatBytes(usage.imageBytes.used),
    limit: formatBytes(usage.imageBytes.limit),
  });

/** The plan's limits and how much of each is used, on Dinghy Cloud. */
function PlanCards({ usage }: { usage: Usage }) {
  return (
    <section className="meters" aria-label={t("usageTitle")}>
      <Meter
        label={t("usageOperators")}
        used={usage.operators.used}
        limit={usage.operators.limit}
        text={operatorsText(usage)}
        note={t("usageOperatorsNote")}
      />
      <Meter
        label={t("usageImages")}
        used={usage.imageBytes.used}
        limit={usage.imageBytes.limit}
        text={imagesText(usage)}
        note={t("usageImagesNote")}
      />
    </section>
  );
}

type Tab = "team" | "install" | "sites" | "secret" | "data";

const TAB_TEXT: Record<Tab, TextId> = {
  team: "tabTeam",
  install: "tabInstall",
  sites: "originsTitle",
  secret: "secretTitle",
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
  onLeft(): void;
}) {
  const team = useTeam(api, role);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsFailure, setSettingsFailure] = useState<TextId | null>(null);
  const [picked, setPicked] = useState<Tab>("team");
  const [inviting, setInviting] = useState(false);

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
  if (settings !== null) tabs.push("install", "sites", "secret");
  if (role === "owner" || team.blocked.length > 0) tabs.push("data");
  const tab = tabs.includes(picked) ? picked : "team";

  return (
    <Page
      title={t("settings")}
      context={settingsContext(workspaceName, usage, team.members.length)}
      // The invite button belongs to the team, so only its tab shows it. The line above stays on
      // every tab, so the tabs do not move when one is picked.
      actions={
        role === "agent" || tab !== "team" ? undefined : (
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
