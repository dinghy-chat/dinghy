/** @jsxImportSource react */
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { BillingRow } from "../../../ee/operator/billing.tsx";
import type {
  BillingState,
  BlockedVisitor,
  Me,
  Member,
  PendingInvite,
  Role,
  Usage,
  WorkspaceApi,
} from "./api.ts";
import { Confirm, Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import {
  Avatar,
  CopyButton,
  ErrorNote,
  Field,
  failureText,
  Icon,
  PageRow,
  ROLE_TEXT,
  Tip,
  useModal,
} from "./ui.tsx";
import { visitorName } from "./visitor.ts";

const teamFailure = (failure: unknown) => failureText(failure, { 409: "lastOwner" });
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

/** Team, blocked visitors and invites load together, and any change to one reloads them all. */
export function useTeam(api: WorkspaceApi, role: Role) {
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
    if (role !== "member") {
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

type Team = ReturnType<typeof useTeam>;

const ROLES = ["owner", "admin", "member"] as const;

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
  const pendingText = t(days === 1 ? "invitePendingOne" : "invitePendingMany", {
    days: String(days),
  });
  const revokeText = t("inviteRevokeLabel", { email: pending.email });
  return (
    <tr>
      <td>
        <div className="who-cell">
          <Avatar name={pending.email} letters={pending.email.slice(0, 1).toUpperCase()} />
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
  { value: "member", label: "roleMember", help: "inviteMemberHelp" },
  { value: "admin", label: "roleAdmin", help: "inviteAdminHelp" },
] as const;

/** The role for an invite, as two pills, with a line on what the picked one can do. */
function RolePicker({
  value,
  onChange,
}: {
  value: "admin" | "member";
  onChange(role: "admin" | "member"): void;
}) {
  const picked = INVITED_ROLES.find((one) => one.value === value) ?? INVITED_ROLES[0];
  return (
    <>
      <fieldset className="choices" aria-label={t("inviteRole")}>
        {INVITED_ROLES.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name="invite-role"
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            {t(choice.label)}
          </label>
        ))}
      </fieldset>
      <p className="hint">{t(picked.help)}</p>
    </>
  );
}

/**
 * "Invite someone": an email and a role. With a mail server the invite goes by email. Without one,
 * the dialog shows a link to copy.
 */
export function InviteDialog({
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
        <h2 id={titleId}>{t("invitesTitle")}</h2>
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
        ) : made.url === null ? (
          <p className="invite-sent" role="status">
            <Icon name="check" size={18} />
            <span>{t("inviteSent", { email: made.email })}</span>
          </p>
        ) : (
          <div className="created">
            <p className="hint">{t("inviteLink", { email: made.email })}</p>
            <div className="copy-field">
              <input
                className="mono"
                readOnly
                aria-label={t("inviteLinkLabel")}
                value={made.url}
                onFocus={(event) => event.target.select()}
              />
              <CopyButton value={made.url} label={t("inviteLinkCopy")} />
            </div>
          </div>
        )}
        <ErrorNote text={error} />
        <div className="dialog-actions">
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

export function TeamTab({
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
  const [revoking, setRevoking] = useState<PendingInvite | null>(null);
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
      {usage !== null && <PlanCards usage={usage} />}
      {role === "owner" && <BillingRow api={api} workspaceId={workspaceId} billing={billing} />}
      {revoking !== null && (
        <Confirm
          title={t("inviteRevokeTitle", { email: revoking.email })}
          text={t("inviteRevokeText")}
          confirm={t("inviteRevokeYes")}
          onConfirm={() => {
            setRevoking(null);
            void team.act(api.revokeInvite(revoking.id));
          }}
          onCancel={() => setRevoking(null)}
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
    </>
  );
}

export function BlockedRow({ api, team }: { api: WorkspaceApi; team: Team }) {
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

export const operatorsText = (usage: Usage) =>
  t("usageOf", {
    used: String(usage.operators.used),
    limit: String(usage.operators.limit),
  });
export const imagesText = (usage: Usage) =>
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
