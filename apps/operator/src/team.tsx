/** @jsxImportSource react */
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  BlockedVisitor,
  Me,
  Member,
  PendingInvite,
  Role,
  Usage,
  WorkspaceApi,
} from "./api.ts";
import { shortDate } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Confirm, Select } from "./popup.tsx";
import { plural, type TextId, t } from "./text.ts";
import {
  Avatar,
  Choices,
  CopyField,
  DocLink,
  ErrorNote,
  Field,
  failureText,
  Page,
  PageRow,
  ROLE_TEXT,
  Tip,
  useModal,
} from "./ui.tsx";
import { visitorName } from "./visitor.ts";

const teamFailure = (failure: unknown) => failureText(failure, { 409: "lastOwner" });

/**
 * The team, its invites and blocked visitors, which load together, and any change to one reloads
 * them all. The members come from the app, which keeps them for the inbox too. Only owners and
 * admins read the invites and the blocked visitors.
 */
export function useTeam(
  api: WorkspaceApi,
  role: Role,
  members: Member[],
  onMembersChanged: () => void,
) {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [blocked, setBlocked] = useState<BlockedVisitor[]>([]);
  const [moreBlocked, setMoreBlocked] = useState(false);
  const [note, setNote] = useState<TextId | null>(null);

  // Each load counts up, so an answer from an older load cannot overwrite a newer one.
  const loads = useRef(0);
  const loadOwn = useCallback(() => {
    const id = ++loads.current;
    const apply =
      <T,>(set: (value: T) => void) =>
      (value: T) => {
        if (id === loads.current) set(value);
      };
    const failed = apply((failure: unknown) => setNote(teamFailure(failure)));
    if (role === "member") return;
    api.blockedVisitors(0).then(
      apply((page) => {
        setBlocked(page.visitors);
        setMoreBlocked(page.hasMore);
      }),
      failed,
    );
    api.invites().then(
      apply((page) => setInvites(page.invites)),
      failed,
    );
  }, [api, role]);
  useEffect(() => {
    loadOwn();
    return () => {
      // A later answer is for a page that is gone.
      loads.current += 1;
    };
  }, [loadOwn]);
  const load = () => {
    onMembersChanged();
    loadOwn();
  };

  const loadingBlocked = useRef(false);
  const loadMoreBlocked = async () => {
    // A ref, because two quick clicks can both run before a render. A second page request from the
    // same offset would add duplicates, and the list would then count past the end.
    if (loadingBlocked.current) return;
    loadingBlocked.current = true;
    const started = loads.current;
    try {
      const page = await api.blockedVisitors(blocked.length);
      // The list loaded again while this page was on its way, so its offset no longer fits.
      if (loads.current !== started) return;
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

export type Team = ReturnType<typeof useTeam>;

const ROLES = ["owner", "admin", "member"] as const;

/** Who is about to leave or be removed, for the dialog that asks first. */
type Leaving = { member: Member; self: boolean };

const TWO_FACTOR_TEXT: Record<Member["twoFactor"], TextId> = {
  off: "teamTwoFactorOff",
  on: "teamTwoFactorOn",
  removal_requested: "teamTwoFactorRemoval",
};
/** The same, on a phone, where the cell's column is gone. Off shows nothing there. */
const TWO_FACTOR_PHONE_TEXT: Record<Member["twoFactor"], TextId | null> = {
  off: null,
  on: "teamTwoFactorOnPhone",
  removal_requested: "teamTwoFactorRemovalPhone",
};

/**
 * Resets a teammate's two-step sign-in. Every teammate it does not apply to shows the same tip, so
 * the button tells nothing about the teammate's other workspaces.
 */
function ResetTwoFactorButton({ member, onReset }: { member: Member; onReset(): void }) {
  const label = t("teamResetTwoFactor", { name: member.name });
  const blocked = !member.canResetTwoFactor;
  return (
    <Tip text={blocked ? t("teamResetTwoFactorBlocked") : label}>
      {(tipId) => (
        // Blocked, it stays focusable, so a keyboard reaches its tip too.
        <button
          type="button"
          className="icon-button quiet-danger"
          aria-label={label}
          aria-describedby={blocked ? tipId : undefined}
          aria-disabled={blocked}
          onClick={() => {
            if (!blocked) onReset();
          }}
        >
          <Icon name="lock" size={18} />
        </button>
      )}
    </Tip>
  );
}

function MemberRow({
  member,
  me,
  role,
  lastOwner,
  onRole,
  onRemove,
  onResetTwoFactor,
}: {
  member: Member;
  me: Me;
  role: Role;
  /** This member is the workspace's only owner. */
  lastOwner: boolean;
  onRole(role: Role): void;
  onRemove(self: boolean): void;
  onResetTwoFactor(): void;
}) {
  const self = member.id === me.id;
  const phoneTwoFactor = TWO_FACTOR_PHONE_TEXT[member.twoFactor];
  const canRemove = self || role === "owner" || (role === "admin" && member.role === "member");
  const removeText = self ? t("leaveWorkspace") : t("removeMember", { name: member.name });
  return (
    <tr>
      <td>
        <div className="who-cell">
          <Avatar name={member.name} pictureUrl={member.pictureUrl} />
          <span className="who-lines">
            <strong>
              {member.name}
              {self && <span className="you">{t("you")}</span>}
            </strong>
            <span className="phone-only">{member.email}</span>
            {phoneTwoFactor !== null && <span className="phone-only">{t(phoneTwoFactor)}</span>}
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
      <td className="two-factor-cell">{t(TWO_FACTOR_TEXT[member.twoFactor])}</td>
      <td className="end-cell">
        {role !== "member" && !self && member.twoFactor !== "off" && (
          <ResetTwoFactorButton member={member} onReset={onResetTwoFactor} />
        )}
        {canRemove && (
          <Tip text={self && lastOwner ? t("leaveBlockedTip") : removeText}>
            {(tipId) => (
              // Blocked, it stays focusable, so a keyboard reaches its tip too.
              <button
                type="button"
                className="icon-button quiet-danger"
                aria-label={removeText}
                aria-describedby={self && lastOwner ? tipId : undefined}
                aria-disabled={self && lastOwner}
                onClick={() => {
                  if (!(self && lastOwner)) onRemove(self);
                }}
              >
                <Icon name={self ? "exit" : "trash"} size={18} />
              </button>
            )}
          </Tip>
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
  const pendingText = plural(days, "invitePendingOne", "invitePendingMany");
  const revokeText = t("inviteRevokeLabel", { email: pending.email });
  return (
    <tr>
      <td>
        <div className="who-cell">
          <Avatar name={pending.email} />
          <span className="who-lines">
            {/* No name until they join. The email column shows the email, except on a phone. */}
            <span className="chip warn">{pendingText}</span>
            <span className="phone-only">{pending.email}</span>
          </span>
        </div>
      </td>
      <td className="email-cell">{pending.email}</td>
      <td>
        <span className="chip">{t(ROLE_TEXT[pending.role])}</span>
      </td>
      <td className="end-cell">
        <button
          type="button"
          className="icon-button quiet-danger"
          aria-label={revokeText}
          title={revokeText}
          onClick={onRevoke}
        >
          <Icon name="trash" size={18} />
        </button>
      </td>
    </tr>
  );
}

const INVITED_ROLES = [
  { value: "member", label: "roleMember" },
  { value: "admin", label: "roleAdmin" },
] as const;

const INVITED_ROLE_HELP: Record<"admin" | "member", TextId> = {
  member: "inviteMemberHelp",
  admin: "inviteAdminHelp",
};

/** The role for an invite, as two pills, with a line on what the picked one can do. */
function RolePicker({
  value,
  onChange,
}: {
  value: "admin" | "member";
  onChange(role: "admin" | "member"): void;
}) {
  const hintId = useId();
  return (
    <>
      <Choices
        label={t("inviteRole")}
        describedBy={hintId}
        value={value}
        options={INVITED_ROLES}
        onChange={onChange}
      />
      <p className="hint" id={hintId}>
        {t(INVITED_ROLE_HELP[value])}
      </p>
    </>
  );
}

/**
 * "Invite someone": an email and a role. With a mail server the invite goes by email. Without one,
 * the dialog shows a link to copy.
 */
function InviteDialog({
  api,
  role,
  emailAvailable,
  onClose,
}: {
  api: WorkspaceApi;
  role: Role;
  /** The server sends email, so the invite goes by email. */
  emailAvailable: boolean;
  onClose(): void;
}) {
  const dialog = useModal();
  const titleId = useId();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  // After a send: the email it went to, and the link to hand out when the server sends no email.
  const [made, setMade] = useState<{ email: string; url: string | null } | null>(null);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await api.createInvite(email.trim(), inviteRole);
      const url =
        created.token === null
          ? null
          : new URL(`/invite?token=${encodeURIComponent(created.token)}`, location.origin).href;
      setMade({ email: created.email, url });
    } catch (failure) {
      setError(
        failureText(failure, {
          409: "inviteeIsMember",
          422: "inviteRejected",
          502: "inviteMailFailed",
        }),
      );
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
      <form className="dialog-body" onSubmit={(event) => void send(event)}>
        {made?.url === null ? (
          <div className="success" role="status">
            <span className="success-icon">
              <Icon name="check" size={22} />
            </span>
            <h2 id={titleId}>{t("inviteSentTitle")}</h2>
            <p>
              <b>{made.email}</b> {t("inviteSentDays")}
            </p>
          </div>
        ) : (
          <h2 id={titleId}>{t("invitesTitle")}</h2>
        )}
        {made === null && (
          <p className="dialog-text">{t(emailAvailable ? "inviteHelpMail" : "inviteHelpLink")}</p>
        )}
        {made === null ? (
          <>
            <Field
              label={t("email")}
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              autoFocus
              value={email}
              onChange={setEmail}
            />
            {role === "owner" ? (
              <RolePicker value={inviteRole} onChange={setInviteRole} />
            ) : (
              <p className="hint">{t("inviteMemberHelp")}</p>
            )}
          </>
        ) : made.url === null ? null : (
          <CopyField
            hint={t("inviteLink", { email: made.email })}
            label={t("inviteLinkLabel")}
            copyLabel={t("inviteLinkCopy")}
            value={made.url}
          />
        )}
        <ErrorNote text={error} />
        <div className={made?.url === null ? "dialog-actions centered" : "dialog-actions"}>
          {made === null ? (
            <>
              <button type="button" className="pill" onClick={() => dialog.current?.close()}>
                {t("cancel")}
              </button>
              <button type="submit" className="pill dark" disabled={busy}>
                {t(busy ? "inviteSending" : emailAvailable ? "inviteSend" : "inviteCreate")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="pill"
                onClick={() => {
                  setMade(null);
                  setEmail("");
                }}
              >
                {t("inviteAnother")}
              </button>
              <button type="button" className="pill dark" onClick={() => dialog.current?.close()}>
                {t("done")}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** The button in the Team page's title row. On a phone the short label keeps it in that row. */
function InviteButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      className="pill dark invite"
      aria-label={t("invitesTitle")}
      onClick={onClick}
    >
      <Icon name="plusBold" size={14} />
      <span className="long-text" aria-hidden="true">
        {t("invitesTitle")}
      </span>
      <span className="short-text" aria-hidden="true">
        {t("inviteShort")}
      </span>
    </button>
  );
}

export function TeamPage({
  api,
  me,
  role,
  team,
  usage,
  emailAvailable,
  workspaceName,
  onLeft,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  team: Team;
  /** On Dinghy Cloud, with pending invites counted. Null with no limits. */
  usage: Usage | null;
  /** The server sends email, so invites go by email. */
  emailAvailable: boolean;
  workspaceName: string;
  onLeft(): void;
}) {
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [revoking, setRevoking] = useState<PendingInvite | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
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
  const manages = role !== "member";
  return (
    <Page
      title={t("pageTeam")}
      context={
        usage === null && !manages ? undefined : (
          <>
            {usage !== null &&
              `${t("teamUsage", { used: usage.operators.used, limit: usage.operators.limit })} `}
            {manages && <DocLink path="operator-guide#set-up-your-team" text="teamRolesLink" />}
          </>
        )
      }
      actions={manages ? <InviteButton onClick={() => setInviting(true)} /> : undefined}
    >
      <table className="members">
        <thead>
          <tr>
            <th scope="col">{t("teamName")}</th>
            <th scope="col" className="email-cell">
              {t("email")}
            </th>
            <th scope="col">{t("teamRole")}</th>
            <th scope="col" className="two-factor-cell">
              {t("teamTwoFactor")}
            </th>
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
              onResetTwoFactor={() => setResetting(member)}
            />
          ))}
          {manages &&
            team.invites.map((pending) => (
              <InviteRow key={pending.id} pending={pending} onRevoke={() => setRevoking(pending)} />
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
      {revoking !== null && (
        <Confirm
          title={t("inviteRevokeTitle", { email: revoking.email })}
          text={t("inviteRevokeText")}
          confirm={t("inviteRevokeYes")}
          cancel={t("inviteKeep")}
          onConfirm={() => {
            setRevoking(null);
            void team.act(api.revokeInvite(revoking.id));
          }}
          onCancel={() => setRevoking(null)}
        />
      )}
      {resetting !== null && (
        <Confirm
          title={t("teamResetTwoFactorTitle", { name: resetting.name })}
          text={t("teamResetTwoFactorText", { name: resetting.name })}
          confirm={t("teamResetTwoFactorYes")}
          onConfirm={() => {
            setResetting(null);
            void team.act(api.resetTwoFactor(resetting.id));
          }}
          onCancel={() => setResetting(null)}
        />
      )}
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

export function BlockedRow({ api, team }: { api: WorkspaceApi; team: Team }) {
  return (
    <PageRow title={t("blockedTitle")} help={t("blockedHelp")}>
      <ul className="item-list">
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
