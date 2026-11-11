// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
/** @jsxImportSource react */
import { useState } from "react";
import {
  type BillingState,
  startCheckout,
  type WorkspaceApi,
} from "../../apps/operator/src/api.ts";
import { useLoad } from "../../apps/operator/src/load.ts";
import { type TextId, t } from "../../apps/operator/src/text.ts";
import { ErrorNote, failureText, PageRow } from "../../apps/operator/src/ui.tsx";

// The states come from the server's leaf module, which has no Node code, so the app can name them.
export type { BillingStateName } from "../server/billing-states.ts";

const STATE_TEXT: Record<BillingState["state"], TextId> = {
  pending: "billingPending",
  free: "billingFree",
  active: "billingActive",
  ending: "billingEnding",
  payment_failed: "billingFailed",
  read_only: "billingReadOnly",
};

const withDate = (id: TextId, date: string | null) =>
  t(id, { date: date === null ? "" : new Date(date).toLocaleDateString() });

/**
 * The owner's billing state, on a server with billing on. Null until it loads, or for others. A
 * new `version` loads it again.
 */
export function useBilling(
  api: WorkspaceApi,
  enabled: boolean,
  version: number,
): BillingState | null {
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  return useLoad(() => (enabled ? api.billing() : null), [api, enabled, version]).data;
}

/** What a failed start of Checkout or the portal tells the owner, by status. */
export const CHECKOUT_FAILURES: Partial<Record<number, TextId>> = {
  429: "tooManyRequests",
  409: "payInProgress",
  503: "checkoutRetryLater",
};

/** Opens Checkout for a subscription that ended, or Stripe's portal for one that failed. */
function PayButton({
  api,
  workspaceId,
  billing,
  label,
  className,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  billing: BillingState;
  label: TextId;
  className: string;
}) {
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      const { url } =
        billing.payWith === "checkout"
          ? await startCheckout(workspaceId)
          : await api.billingPortal();
      location.assign(url);
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, CHECKOUT_FAILURES));
    }
  };
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => void pay()}>
        {t(label)}
      </button>
      <ErrorNote text={error} />
    </>
  );
}

/**
 * Above every page of a workspace that waits for the cloud. Once the server takes payments, the
 * owner turns it on through Checkout.
 */
export function WaitingBanner({
  api,
  workspaceId,
  email,
  owner,
  billing,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  email: string;
  owner: boolean;
  /** True when this server takes payments. */
  billing: boolean;
}) {
  if (!billing) {
    return (
      <div className="banner billing-banner waiting-banner" role="status">
        {/* A phone shows the short line, so the banner stays one line tall. */}
        <span className="long-text">{t("waitingBanner", { email })}</span>
        <span className="short-text">{t("waitingBannerShort")}</span>
      </div>
    );
  }
  if (!owner) {
    return (
      <div className="banner billing-banner waiting-banner" role="status">
        {t("turnOnMember")}
      </div>
    );
  }
  return (
    <div className="banner billing-banner waiting-banner" role="status">
      <span>{t("turnOnBanner")}</span>
      <PayButton
        api={api}
        workspaceId={workspaceId}
        billing={{ state: "pending", date: null, payWith: "checkout" }}
        label="turnOnButton"
        className="btn light small"
      />
    </div>
  );
}

/** Above the inbox, for a read-only workspace, and for an owner whose payment failed. */
export function BillingBanner({
  api,
  workspaceId,
  readOnly,
  billing,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  readOnly: boolean;
  billing: BillingState | null;
}) {
  if (billing?.state === "read_only" || billing?.state === "payment_failed") {
    const readOnlyNow = billing.state === "read_only";
    return (
      <div className="banner billing-banner" role="status">
        <span>
          {withDate(readOnlyNow ? "readOnlyBanner" : "paymentFailedBanner", billing.date)}
        </span>
        <PayButton
          api={api}
          workspaceId={workspaceId}
          billing={billing}
          label={readOnlyNow && billing.payWith === "checkout" ? "payAgain" : "updateCard"}
          className="btn light small"
        />
      </div>
    );
  }
  if (!readOnly) return null;
  return (
    <div className="banner billing-banner" role="status">
      {t("readOnlyMember")}
    </div>
  );
}

/** The owner's view of the subscription, with Stripe's portal. */
export function BillingRow({
  api,
  workspaceId,
  billing,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  billing: BillingState | null;
}) {
  if (billing === null) return null;
  // Neither has a Stripe customer, so the portal has nothing to show.
  const noPortal = billing.state === "pending" || billing.state === "free";
  return (
    <PageRow
      title={t("billingTitle")}
      {...(!noPortal && { help: t("billingHelp") })}
      docs={[{ path: "operator-guide#billing", text: "billingDocsLink" }]}
    >
      <p>{withDate(STATE_TEXT[billing.state], billing.date)}</p>
      {!noPortal && (
        <div className="actions">
          <PayButton
            api={api}
            workspaceId={workspaceId}
            billing={{ ...billing, payWith: "portal" }}
            label="billingManage"
            className="btn navy small"
          />
        </div>
      )}
    </PageRow>
  );
}
