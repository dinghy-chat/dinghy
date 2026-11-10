// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { operator, subscription, workspaceMember } from "../../../apps/server/src/db/schema.ts";
import { createWorkspace } from "../../../apps/server/src/workspaces.ts";
import { startE2EServer } from "../../../apps/server/test/e2e-server.ts";
import { createBilling } from "../billing.ts";
import { runLifecycle } from "../lifecycle.ts";
import {
  STRIPE_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  startFakeStripe,
} from "./fake-stripe.ts";

/** Dinghy's own workspace and its founder, as the welcome chat's settings name them. */
const FOUNDER_EMAIL = "julien@dinghy.example";

/**
 * The real server as Dinghy Cloud runs it, for browser tests. With `billing`, a fake of Stripe's
 * API and Checkout page stands in for Stripe. With `welcome`, each new workspace starts with a chat
 * with the founder. Postgres and Valkey stay real.
 */
export async function startCloudE2EServer({
  billing = false,
  early = false,
  welcome = false,
} = {}) {
  const stripe = billing ? await startFakeStripe() : null;
  const keys =
    stripe === null
      ? undefined
      : {
          secretKey: STRIPE_SECRET_KEY,
          webhookSecret: STRIPE_WEBHOOK_SECRET,
          priceId: STRIPE_PRICE_ID,
          apiBase: stripe.apiBase,
        };
  const server = await startE2EServer(
    {},
    {
      cloud: async ({ db, owner }) => {
        const settings = { billing: keys, ...(early && { signup: "early" as const }) };
        if (!welcome) return settings;
        const dinghy = await createWorkspace(db, "Dinghy", []);
        const [julien] = await owner
          .insert(operator)
          .values({ name: "Julien", email: FOUNDER_EMAIL })
          .returning({ id: operator.id });
        await owner
          .insert(workspaceMember)
          .values({ workspaceId: dinghy.id, operatorId: julien?.id ?? "", role: "owner" });
        return { ...settings, welcome: { workspaceId: dinghy.id, operatorEmail: FOUNDER_EMAIL } };
      },
    },
  );
  const { apiOrigin, owner, workerDb, signals } = server;

  /** Sends Stripe's signed webhook to the real server. */
  const sendWebhook = async (type: string, object: Record<string, unknown>) => {
    if (stripe === null) throw new Error("Billing is off");
    const event = stripe.event(type, object);
    const response = await fetch(`${apiOrigin}/v1/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      body: event.payload,
    });
    if (!response.ok) throw new Error(`The webhook answered ${response.status}`);
  };

  return {
    ...server,
    stripe,
    /** Pays a Checkout Session and sends Stripe's signed webhook to the real server. */
    async completeCheckout(sessionId: string) {
      if (stripe === null) throw new Error("Billing is off");
      const paid = stripe.pay(sessionId);
      await sendWebhook("checkout.session.completed", {
        object: "checkout.session",
        client_reference_id: paid.metadata.workspace_id,
        subscription: paid.id,
      });
    },
    /** Ends a workspace's subscription at Stripe, and runs the worker's pass that makes it read-only. */
    async endSubscription(workspaceId: string) {
      if (stripe === null || keys === undefined) throw new Error("Billing is off");
      const ended = [...stripe.subscriptions.values()].find(
        (one) => one.metadata.workspace_id === workspaceId,
      );
      if (ended === undefined) throw new Error("The workspace has no subscription");
      ended.status = "canceled";
      await sendWebhook("customer.subscription.deleted", {
        id: ended.id,
        object: "subscription",
        metadata: ended.metadata,
      });
      const logger = pino({ level: "silent" });
      await runLifecycle({
        db: workerDb,
        billing: createBilling(keys, workerDb, logger, signals),
        logger,
        publicUrl: apiOrigin,
      });
    },
    /** Makes a workspace read-only in the database alone, as if this page missed the change. */
    async markReadOnly(workspaceId: string) {
      await owner
        .update(subscription)
        .set({ status: "canceled", readOnlyAt: new Date() })
        .where(eq(subscription.workspaceId, workspaceId));
    },
    async stop() {
      await stripe?.stop();
      await server.stop();
    },
  };
}
