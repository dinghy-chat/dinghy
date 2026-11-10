// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { eq } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import type { App } from "../../apps/server/src/app.ts";
import type { Auth } from "../../apps/server/src/auth.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { subscription } from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import type { Limits } from "../../apps/server/src/limits.ts";
import type { Live, Signals } from "../../apps/server/src/live.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import type { RateLimit } from "../../apps/server/src/rate-limit.ts";
import {
  type BillingOptions,
  billingFromConfig,
  createBilling,
  registerBillingRoutes,
} from "./billing.ts";
import { runLifecycle } from "./lifecycle.ts";
import { createLimits, type LimitOptions } from "./limits.ts";
import { removeOldImages } from "./retention.ts";
import { CLOUD_CONTACT, registerSignup, type SignupMode } from "./signup.ts";

/** For `chat signups`, which lists the early signups that wait for the cloud. */
export { signupsCsv } from "./signup.ts";

/**
 * The entry point that core calls: once in the app, once in the worker. Nothing here runs on a
 * server without the cloud's settings, so a self-hosted install never turns this folder on.
 */
export interface CloudSettings {
  /** The cloud plan's billing. Signup then asks for payment, and Checkout and the webhook exist. */
  billing?: BillingOptions | undefined;
  /** `early` opens signup with no billing, before the cloud takes payments. Billing overrides it. */
  signup?: "early" | undefined;
  /** Smaller limits, for tests. The plan's own apply otherwise. */
  limits?: LimitOptions | undefined;
}

/** The cloud's settings, or none on a self-hosted install, which leaves them all unset. */
export function cloudFromConfig(config: Config): CloudSettings | undefined {
  const billing = billingFromConfig(config);
  if (billing === undefined && config.CLOUD_SIGNUP === undefined) return undefined;
  return { billing, signup: config.CLOUD_SIGNUP };
}

export interface CloudDeps {
  auth: Auth;
  db: Database;
  live: Live;
  logger: Logger;
  mailer: Mailer | undefined;
  rateLimit: RateLimit;
  valkey: Redis | null;
}

/** What the app needs from the cloud: its flags, the delete hook and its routes. */
export interface Cloud {
  billing: boolean;
  signup: SignupMode;
  /** Cancels the subscription before the owner's delete. A throw stops the delete. */
  beforeDelete: ((workspaceId: string) => Promise<void>) | undefined;
  now: () => Date;
  /** The plan's limits on operators, images and open streams. */
  limits: Limits;
  /** Where a suspended workspace's operators write to. */
  contact: string;
  /** Checkout, the portal, the webhook and signup. */
  registerRoutes(app: App): void;
}

/** The cloud's part of the app, or none when its settings are unset. */
export function createCloud(
  settings: CloudSettings | undefined,
  deps: CloudDeps,
): Cloud | undefined {
  const billing = settings?.billing;
  const signup: SignupMode | null =
    billing !== undefined ? "payment" : settings?.signup === "early" ? "early" : null;
  if (signup === null) return undefined;
  const { auth, db, live, logger, mailer, rateLimit, valkey } = deps;
  const client = billing === undefined ? undefined : createBilling(billing, db, logger, live);
  return {
    billing: client !== undefined,
    signup,
    now: client?.now ?? (() => new Date()),
    limits: createLimits(valkey, logger, settings?.limits),
    contact: CLOUD_CONTACT,
    beforeDelete:
      client &&
      (async (workspaceId) => {
        const [found] = await withWorkspace(db, workspaceId, (tx) =>
          tx
            .select({ customerId: subscription.stripeCustomerId })
            .from(subscription)
            .where(eq(subscription.workspaceId, workspaceId)),
        );
        if (found !== undefined) await client.cancelAll(found.customerId);
      }),
    registerRoutes(app) {
      if (billing !== undefined && client !== undefined) {
        registerBillingRoutes(app, { auth, billing, client, db, rateLimit });
      }
      registerSignup(app, { auth, db, logger, mailer, mode: signup, rateLimit, valkey });
    },
  };
}

export interface CloudWorkerDeps {
  db: Database;
  logger: Logger;
  publicUrl: string;
  signals: Signals;
}

/** One pass of the cloud's jobs. The lifecycle claims its rows for its own 10 minutes. */
export type CloudWorkerStep = (pass: { mailer: Mailer | undefined }) => Promise<void>;

/**
 * The cloud's worker pass: images older than 12 months go, and with billing, the subscription
 * lifecycle runs. None on a self-hosted install.
 */
export function cloudWorkerStep(
  settings: CloudSettings | undefined,
  { db, logger, publicUrl, signals }: CloudWorkerDeps,
): CloudWorkerStep | undefined {
  if (settings === undefined) return undefined;
  const billing =
    settings.billing === undefined
      ? undefined
      : createBilling(settings.billing, db, logger, signals);
  return async ({ mailer }) => {
    const removed = await removeOldImages(db);
    if (removed > 0) logger.info({ removed }, "removed images older than 12 months");
    if (billing !== undefined) {
      await runLifecycle({ db, billing, logger, mailer, publicUrl });
    }
  };
}
