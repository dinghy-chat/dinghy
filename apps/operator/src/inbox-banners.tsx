/** @jsxImportSource react */
import { BillingBanner, WaitingBanner } from "../../../ee/operator/billing.tsx";
import type { BillingState, Me, WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { t } from "./text.ts";

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

/** The banners above every page: a lost stream, a workspace just deleted, and the plan. */
export function InboxBanners({
  lost,
  deletedName,
  onCloseDeleted,
  ...plan
}: PlanProps & {
  lost: boolean;
  /** The workspace the operator just deleted, for a note, or null. */
  deletedName: string | null;
  onCloseDeleted(): void;
}) {
  return (
    <>
      {lost && (
        <div className="banner" role="status">
          {t("reconnecting")}
        </div>
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
    </>
  );
}
