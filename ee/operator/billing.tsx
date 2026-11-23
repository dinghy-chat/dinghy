// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
/** @jsxImportSource react */
import { type ReactNode, useEffect, useState } from "react";
import {
  type BillingDetails,
  type BillingState,
  startCheckout,
  type WorkspaceApi,
} from "../../apps/operator/src/api.ts";
import { Icon } from "../../apps/operator/src/icons.tsx";
import { useLoad } from "../../apps/operator/src/load.ts";
import { type TextId, t } from "../../apps/operator/src/text.ts";
import {
  DocLink,
  ErrorNote,
  failureText,
  Loading,
  Page,
  PageRow,
} from "../../apps/operator/src/ui.tsx";
import { formatMoney } from "./money.ts";

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

/** The words on the plan's status chip, and its color. */
const STATE_CHIP: Record<BillingState["state"], { text: TextId; tone: string }> = {
  pending: { text: "billingChipPending", tone: "warn" },
  free: { text: "billingChipFree", tone: "open" },
  active: { text: "billingChipActive", tone: "open" },
  ending: { text: "billingChipEnding", tone: "warn" },
  payment_failed: { text: "billingChipFailed", tone: "bad" },
  read_only: { text: "billingChipReadOnly", tone: "bad" },
};

const INVOICE_TEXT: Record<BillingDetails["invoices"][number]["status"], TextId> = {
  paid: "invoicePaid",
  open: "invoiceOpen",
  void: "invoiceVoid",
  uncollectible: "invoiceUnpaid",
};

/** How often the price is charged, by Stripe's interval: once each, or every so many. */
const PERIOD_TEXT: Partial<Record<string, { one: TextId; many: TextId }>> = {
  day: { one: "billingPerDay", many: "billingEveryDays" },
  week: { one: "billingPerWeek", many: "billingEveryWeeks" },
  month: { one: "billingPerMonth", many: "billingEveryMonths" },
  year: { one: "billingPerYear", many: "billingEveryYears" },
};

/** "per month", or "every 3 months" for a longer period. */
function perPeriod({ interval, intervalCount }: NonNullable<BillingDetails["price"]>): string {
  const text = PERIOD_TEXT[interval] ?? PERIOD_TEXT.month;
  if (text === undefined) return "";
  return intervalCount === 1 ? t(text.one) : t(text.many, { count: String(intervalCount) });
}

const day = (date: string) =>
  new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** What the owner can do about the plan now: manage it, fix the card or pay again. */
function planAction(
  billing: BillingState,
): { label: TextId; payWith: BillingState["payWith"] } | null {
  switch (billing.state) {
    case "active":
    case "ending":
      return { label: "billingManage", payWith: "portal" };
    case "payment_failed":
      return { label: "updateCard", payWith: "portal" };
    case "read_only":
      return {
        label: billing.payWith === "checkout" ? "payAgain" : "updateCard",
        payWith: billing.payWith,
      };
    case "pending":
    case "free":
      return null;
  }
}

/** The plan at the top of the page: its price, its state and what to do about it. */
function PlanCard({
  api,
  workspaceId,
  billing,
  price,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  billing: BillingState;
  price: BillingDetails["price"];
}) {
  const chip = STATE_CHIP[billing.state];
  const action = planAction(billing);
  return (
    <section className="plan-card" aria-labelledby="plan-name">
      <div className="plan-top">
        <div>
          <p className="plan-eyebrow">{t("billingPlanLabel")}</p>
          <h3 id="plan-name">{t("billingPlanName")}</h3>
        </div>
        <span className={`chip ${chip.tone}`}>{t(chip.text)}</span>
      </div>
      {billing.state !== "free" && price !== null && (
        <p className="plan-price">
          <strong className="plan-amount">{formatMoney(price)}</strong>
          <span>{perPeriod(price)}</span>
        </p>
      )}
      <p className="plan-state">{withDate(STATE_TEXT[billing.state], billing.date)}</p>
      {action !== null && (
        <div className="actions">
          <PayButton
            api={api}
            workspaceId={workspaceId}
            billing={{ ...billing, payWith: action.payWith }}
            label={action.label}
            className="pill dark"
          />
        </div>
      )}
    </section>
  );
}

/** The card on file, with a way to change it on Stripe. */
function CardRow({
  api,
  workspaceId,
  billing,
  card,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  billing: BillingState;
  card: NonNullable<BillingDetails["card"]>;
}) {
  const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
  const expires = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`;
  return (
    <PageRow title={t("billingCardTitle")} help={t("billingCardHelp")}>
      <div>
        <p className="card-number">{t("billingCardEnding", { brand, last4: card.last4 })}</p>
        <p className="hint">{t("billingCardExpires", { date: expires })}</p>
      </div>
      <div className="actions">
        <PayButton
          api={api}
          workspaceId={workspaceId}
          billing={{ ...billing, payWith: "portal" }}
          label="billingCardChange"
          className="pill"
        />
      </div>
    </PageRow>
  );
}

/** The newest invoices, each with a link to Stripe's page and its PDF. */
function InvoicesRow({ invoices }: { invoices: BillingDetails["invoices"] }) {
  return (
    <PageRow title={t("billingInvoicesTitle")} help={t("billingInvoicesHelp")}>
      {invoices.length === 0 ? (
        <p className="hint">{t("billingNoInvoices")}</p>
      ) : (
        <table className="invoices">
          <thead>
            <tr>
              <th scope="col">{t("invoiceDate")}</th>
              <th scope="col">{t("invoiceAmount")}</th>
              <th scope="col">{t("invoiceStatus")}</th>
              <th scope="col" className="end-cell">
                <span className="visually-hidden">{t("invoiceOpenLink")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>{day(invoice.date)}</td>
                <td className="invoice-amount">{formatMoney(invoice)}</td>
                <td>
                  <span className={invoice.status === "paid" ? "chip open" : "chip warn"}>
                    {t(INVOICE_TEXT[invoice.status])}
                  </span>
                </td>
                <td className="end-cell">
                  {invoice.url !== null && (
                    <a
                      className="text-button"
                      href={invoice.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("invoiceOpenNamed", { date: day(invoice.date) })}
                    >
                      {t("invoiceOpenLink")}
                      <Icon name="arrowUpRight" size={14} />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageRow>
  );
}

/**
 * Settings > Billing, for an owner on Dinghy Cloud: the plan and its state, the usage, the card
 * and the invoices. Stripe's portal changes the card or cancels.
 */
export function BillingPage({
  api,
  workspaceId,
  inboxBilling,
  usage,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  /** The inbox's copy of the billing state, which its live events load again. Null until it loads. */
  inboxBilling: BillingState | null;
  usage: ReactNode;
}) {
  // The page reads the state when it opens, and the inbox's live events bring each change after.
  // Whichever came last shows, so neither an old inbox answer nor an old read wins. A failed read
  // shows only when nothing else has come.
  const loaded = useLoad(() => api.billing(), [api]);
  const [latest, setLatest] = useState(inboxBilling);
  useEffect(() => {
    if (inboxBilling !== null) setLatest(inboxBilling);
  }, [inboxBilling]);
  useEffect(() => {
    if (loaded.data !== null) setLatest(loaded.data);
  }, [loaded.data]);
  const billing = { data: latest, failure: latest === null ? loaded.failure : null };
  const details = useLoad(() => api.billingDetails(), [api]);
  return (
    <Page
      title={t("pageBilling")}
      context={
        <>
          {t("billingContext")} <DocLink path="operator-guide#billing" text="billingDocsLink" />
        </>
      }
    >
      {billing.data === null ? (
        <Loading failure={billing.failure} />
      ) : (
        <PlanCard
          api={api}
          workspaceId={workspaceId}
          billing={billing.data}
          price={details.data?.price ?? null}
        />
      )}
      {usage}
      {details.data === null ? (
        <ErrorNote text={details.failure} />
      ) : (
        <>
          {billing.data !== null && details.data.card !== null && (
            <CardRow
              api={api}
              workspaceId={workspaceId}
              billing={billing.data}
              card={details.data.card}
            />
          )}
          <InvoicesRow invoices={details.data.invoices} />
        </>
      )}
    </Page>
  );
}
