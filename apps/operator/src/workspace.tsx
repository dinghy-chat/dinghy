/** @jsxImportSource react */
import { useState } from "react";
import { BillingRow } from "../../../ee/operator/billing.tsx";
import type { BillingState, Usage, WorkspaceApi, WorkspaceSettings } from "./api.ts";
import { Confirm } from "./popup.tsx";
import { BlockedRow, type Team } from "./team.tsx";
import { type TextId, t } from "./text.ts";
import {
  DocLink,
  ErrorNote,
  failureText,
  ImageUpload,
  NameField,
  Page,
  PageRow,
  TypeToConfirm,
  type UploadText,
} from "./ui.tsx";

const LOGO_TEXT: UploadText = {
  upload: "logoUpload",
  replace: "logoReplace",
  remove: "logoRemove",
  preview: "logoPreview",
  tooLarge: "logoTooLarge",
};

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
  full,
}: {
  label: string;
  used: number;
  limit: number;
  text: string;
  note: TextId;
  /** What to do once nothing is left, which differs for people and for images. */
  full: TextId;
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
        {t(level === "ok" ? note : level === "full" ? full : "usageNear")}
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
function PlanRow({ usage }: { usage: Usage }) {
  return (
    <PageRow title={t("usageTitle")}>
      <div className="meters">
        <Meter
          label={t("usageOperators")}
          used={usage.operators.used}
          limit={usage.operators.limit}
          text={operatorsText(usage)}
          note="usageOperatorsNote"
          full="usageFullTeam"
        />
        <Meter
          label={t("usageImages")}
          used={usage.imageBytes.used}
          limit={usage.imageBytes.limit}
          text={imagesText(usage)}
          note="usageImagesNote"
          full="usageFullImages"
        />
      </div>
      <DocLink path="operator-guide#plan-and-usage" text="usageDocsLink" />
    </PageRow>
  );
}

type Deletion = WorkspaceSettings["deletion"];

/** "This permanently deletes 312 conversations and 40 images. It removes workspace access for 3 team members, ..." */
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
  endsSubscription,
  deletion,
  startOpen,
  onDeleted,
}: {
  api: WorkspaceApi;
  name: string;
  endsSubscription: boolean;
  /** What the delete removes, once the settings have loaded. */
  deletion: Deletion | null;
  /** The account's delete opened this workspace to delete it. */
  startOpen: boolean;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(startOpen);
  const help = endsSubscription
    ? `${t("deleteWorkspaceHelp")} ${t("deleteWorkspaceCloud")}`
    : t("deleteWorkspaceHelp");
  return (
    <PageRow title={t("deleteWorkspaceTitle")} help={help} danger>
      {/* An outline, as for replacing the secret. The filled red is for the confirm step. */}
      <button type="button" className="pill danger-soft" onClick={() => setOpen(true)}>
        {t("deleteWorkspaceOpen")}
      </button>
      <DocLink path="self-hosting#deleting-a-workspace" text="deleteWorkspaceDocsLink" />
      {open && (
        <DeleteWorkspaceDialog
          api={api}
          name={name}
          endsSubscription={endsSubscription}
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
  endsSubscription,
  deletion,
  exportUrl,
  onDeleted,
  onCancel,
}: {
  api: Pick<WorkspaceApi, "deleteWorkspace">;
  name: string;
  /** A cloud workspace with a subscription, which the delete ends. */
  endsSubscription: boolean;
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
          { 400: "deleteWorkspaceFailed", 429: "tooManyRequests" },
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
          <p>{endsSubscription ? `${goes} ${t("deleteWorkspaceCloud")}` : goes}</p>
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

/**
 * The workspace: its name and logo, the plan, blocked visitors, the export and the delete. Owners
 * and admins see it, and only an owner exports or deletes.
 */
export function WorkspacePage({
  api,
  isOwner,
  name,
  logoUrl,
  endsSubscription,
  deletion,
  usage,
  billing,
  workspaceId,
  team,
  openDelete,
  onDeleted,
}: {
  api: WorkspaceApi;
  isOwner: boolean;
  name: string;
  logoUrl: string | null;
  /** A cloud workspace with a subscription, which the delete ends. */
  endsSubscription: boolean;
  /** What the delete removes, once the settings have loaded. */
  deletion: Deletion | null;
  /** On Dinghy Cloud, with pending invites counted. Null with no limits. */
  usage: Usage | null;
  billing: BillingState | null;
  workspaceId: string;
  team: Team;
  /** The account's delete opened this workspace to delete it. */
  openDelete: boolean;
  onDeleted(): void;
}) {
  return (
    <Page title={t("pageWorkspace")} context={t("workspaceContext")}>
      {/* The server's workspace.changed event loads the account again, here and in other apps. */}
      <PageRow title={t("workspaceNameLabel")}>
        <NameField
          label={t("workspaceNameLabel")}
          name={name}
          autoComplete="organization"
          onSave={api.rename}
        />
      </PageRow>
      <PageRow title={t("logoTitle")} help={t("logoHelp")}>
        <ImageUpload
          url={logoUrl}
          text={LOGO_TEXT}
          onUpload={api.setLogo}
          onRemove={api.removeLogo}
        />
      </PageRow>
      {usage !== null && <PlanRow usage={usage} />}
      {isOwner && <BillingRow api={api} workspaceId={workspaceId} billing={billing} />}
      {team.blocked.length > 0 && <BlockedRow api={api} team={team} />}
      {isOwner && (
        <PageRow title={t("exportTitle")} help={t("exportHelp")}>
          <a className="pill" href={api.exportUrl} download>
            {t("exportDownload")}
          </a>
          <DocLink path="self-hosting#moving-a-workspace" text="exportDocsLink" />
        </PageRow>
      )}
      {isOwner && (
        <DeleteRow
          api={api}
          name={name}
          endsSubscription={endsSubscription}
          deletion={deletion}
          startOpen={openDelete}
          onDeleted={onDeleted}
        />
      )}
    </Page>
  );
}
