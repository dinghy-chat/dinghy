/** @jsxImportSource react */
import { BillingBanner, WaitingBanner } from "../../../ee/operator/billing.tsx";
import { ApiError, type BillingState, cancelRemoval, type Me, type WorkspaceApi } from "./api.ts";
import { BotsPausedBanner } from "./bots.tsx";
import { dayTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useAction } from "./load.ts";
import { t } from "./text.ts";
import { toast } from "./toast.tsx";
import { ErrorNote } from "./ui.tsx";

interface PlanProps {
  api: WorkspaceApi;
  me: Me;
  workspaceId: string;
  isOwner: boolean;
  readOnly: boolean;
  suspended: boolean;
  waitsForCloud: boolean;
  billing: BillingState | null;
}

/** Above every page of a suspended workspace, with whom to write to. */
function SuspendedBanner({ contact }: { contact: string | null }) {
  if (contact === null) {
    return (
      <div className="banner billing-banner" role="status">
        {t("suspendedBannerSelfHosted")}
      </div>
    );
  }
  const [before, after] = t("suspendedBanner").split("{contact}");
  return (
    <div className="banner billing-banner" role="status">
      <span>
        {before}
        <a href={`mailto:${contact}`}>{contact}</a>
        {after}
      </span>
    </div>
  );
}

/**
 * On every session that passed the check while someone asks to remove two-step sign-in: the one
 * place in the app where the real owner can stop it.
 */
function RemovalBanner({ completesAt, onCancelled }: { completesAt: string; onCancelled(): void }) {
  const cancel = useAction(onCancelled);
  // A 409 means no request waits any more: a code, a link or another device came first, so `me`
  // loads again with no toast.
  const run = async () => {
    try {
      await cancelRemoval();
      toast("removalCancelledTitle");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  };
  return (
    <div className="banner billing-banner" role="status">
      <span>{t("removalBanner", { date: dayTime(completesAt) })}</span>
      <button
        type="button"
        className="btn light small"
        disabled={cancel.busy}
        onClick={() => void cancel.run(run)}
      >
        {t("removalCancel")}
      </button>
      <ErrorNote text={cancel.failure} />
    </div>
  );
}

/** The workspace's plan: suspended, waiting for the cloud, or its billing. */
function PlanBanner({
  api,
  me,
  workspaceId,
  isOwner,
  readOnly,
  suspended,
  waitsForCloud,
  billing,
}: PlanProps) {
  if (suspended) return <SuspendedBanner contact={me.contact} />;
  if (waitsForCloud) {
    return (
      <WaitingBanner
        api={api}
        workspaceId={workspaceId}
        email={me.email}
        owner={isOwner}
        billing={me.billing}
      />
    );
  }
  return (
    <BillingBanner api={api} workspaceId={workspaceId} readOnly={readOnly} billing={billing} />
  );
}

/**
 * The banners above every page: a lost stream, a removal request that waits, a workspace just
 * deleted, the plan, and paused bots.
 */
export function InboxBanners({
  lost,
  deletedName,
  onCloseDeleted,
  botsPaused,
  botsPausedBy,
  botsPausedAt,
  onResumeBots,
  onRemovalCancelled,
  ...plan
}: PlanProps & {
  lost: boolean;
  /** The workspace the operator just deleted, for a note, or null. */
  deletedName: string | null;
  onCloseDeleted(): void;
  botsPaused: boolean;
  /** Who paused them, or null. */
  botsPausedBy: string | null;
  /** When they were paused, or null. */
  botsPausedAt: string | null;
  /** Null for a member, who cannot resume them. */
  onResumeBots: (() => void) | null;
  /** A cancel changes `me`, which then loads again. */
  onRemovalCancelled(): void;
}) {
  return (
    <>
      {lost && (
        <div className="banner" role="status">
          {t("reconnecting")}
        </div>
      )}
      {plan.me.removalCompletesAt !== null && (
        <RemovalBanner completesAt={plan.me.removalCompletesAt} onCancelled={onRemovalCancelled} />
      )}
      {deletedName !== null && (
        <div className="banner deleted-banner" role="status">
          {t("workspaceDeleted", { name: deletedName })}
          <button
            type="button"
            className="icon-button"
            aria-label={t("close")}
            onClick={onCloseDeleted}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <PlanBanner {...plan} />
      {botsPaused && (
        <BotsPausedBanner pausedBy={botsPausedBy} pausedAt={botsPausedAt} onResume={onResumeBots} />
      )}
    </>
  );
}
