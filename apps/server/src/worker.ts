import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { type CloudSettings, cloudWorkerStep } from "../../../ee/server/index.ts";
import {
  type AlertPlan,
  type ClaimedDelivery,
  claimDeliveries,
  fanOutOne,
  finishDelivery,
  MAX_ATTEMPTS,
  planDelivery,
  postponeDelivery,
  pruneOnce,
  RETENTION_MS,
  releaseDelivery,
  retryDelivery,
  sendToOperator,
} from "./alerts.ts";
import { workerHeartbeat } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import type { Images } from "./images.ts";
import { noLive, type Signals } from "./live.ts";
import { MAIL_CONNECTIONS, type Mailer } from "./mailer.ts";
import type { Push } from "./push.ts";
import {
  type ClaimedDeletion,
  claimDeletions,
  finishDeletion,
  type ObjectStore,
  retryDeletion,
} from "./storage.ts";
import {
  abandonWebhook,
  claimWebhookDeliveries,
  deliverWebhook,
  fanOutWebhooksOne,
  PUBLIC_ONLY,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookPolicy,
} from "./webhooks.ts";
import { purgeDeletedWorkspaces } from "./workspace-delete.ts";

/** Records that a pass finished. Every worker instance writes the same row. */
async function recordHeartbeat(db: Database): Promise<void> {
  const passedAt = new Date();
  await db
    .insert(workerHeartbeat)
    .values({ passedAt })
    .onConflictDoUpdate({ target: workerHeartbeat.id, set: { passedAt } });
}

/** When any worker last finished a pass, or null if none ever did. */
export async function lastWorkerPass(db: Database): Promise<Date | null> {
  const [row] = await db.select({ passedAt: workerHeartbeat.passedAt }).from(workerHeartbeat);
  return row?.passedAt ?? null;
}

export interface Worker {
  stop(): Promise<void>;
}

interface WorkerOptions {
  db: Database;
  logger: Logger;
  push?: Push | undefined;
  mailer?: Mailer | undefined;
  /** Where deleted conversations' images are removed from. */
  store?: ObjectStore | undefined;
  /** Signs the image URLs in a webhook's message. Without it, a webhook's image is null. */
  images?: Images | undefined;
  /** Whether webhooks may go over http and to private addresses. */
  webhooks?: WebhookPolicy;
  /** Dinghy Cloud's settings, read by `ee/`. Without billing, no subscription lifecycle runs. */
  cloud?: CloudSettings | undefined;
  /** Wakes open inboxes after a billing change. */
  signals?: Signals | undefined;
  publicUrl: string;
  secret: string;
  /** How often the subscription lifecycle and the purge of deleted workspaces run. */
  lifecycleMs?: number;
  pollMs?: number;
  retryMs?: number;
  deleteTimeoutMs?: number;
  /** How long one email may take before it becomes a retry. */
  mailTimeoutMs?: number;
}

const BATCH = 10;
/** Sends in flight at once. Each finished one frees a slot, so a slow device holds only its own. */
const IN_FLIGHT = 20;
/** How long a claimed delivery or deletion stays with this worker before another may take it. */
const CLAIM_MS = 60_000;
const FAN_OUT_BATCH = 50;
const PRUNE_EVERY_MS = 60 * 60_000;
const LIFECYCLE_EVERY_MS = 60_000;
const MAIL_TIMEOUT_MS = 20_000;
/** How long an idle worker waits before its next pass, unless a finished send wakes it. */
const POLL_MS = 2000;
/** The first wait before a failed alert or file deletion is tried again. */
const RETRY_MS = 30_000;
/** How long one file deletion may take before it becomes a retry. */
const DELETE_TIMEOUT_MS = 30_000;
/** How often a worker records that its passes still finish. */
const HEARTBEAT_EVERY_MS = 30_000;
// A stop must finish before the process's 8-second limit.
const STOP_WAIT_MS = 5000;

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * A stalled SMTP server must not hold the worker's pass, which also runs alerts and deletions. An
 * email waits for a free connection before its time starts, so a send that waits in nodemailer's
 * queue never times out there and goes out twice. An email that finds no free connection in time
 * becomes a retry: it never reached nodemailer, so it cannot go out twice either. A connection
 * counts as taken until nodemailer is done with it, even after the worker stopped waiting.
 */
function boundedMailer(mailer: Mailer, stopping: AbortSignal, timeoutMs: number): Mailer {
  const deadline = () => AbortSignal.any([stopping, AbortSignal.timeout(timeoutMs)]);
  let sending = 0;
  const waiters: (() => void)[] = [];
  const takeConnection = async (signal: AbortSignal) => {
    let gaveUp: Promise<never> | undefined;
    while (sending >= MAIL_CONNECTIONS) {
      gaveUp ??= aborted(signal);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), gaveUp]);
    }
    sending += 1;
  };
  // Every waiter checks again, because one that gave up waiting is still in the list, and waking
  // only the first could wake nobody. There are at most IN_FLIGHT of them.
  const freeConnection = () => {
    sending -= 1;
    for (const resolve of waiters.splice(0)) resolve();
  };
  return {
    async send(to, subject, text, headers) {
      await takeConnection(deadline());
      const sent = mailer.send(to, subject, text, headers).finally(freeConnection);
      // A send that fails after the worker stopped waiting must not crash the process.
      sent.catch(() => {});
      await Promise.race([sent, aborted(deadline())]);
    },
  };
}

export function startWorker({
  db,
  logger,
  push,
  mailer,
  store,
  images,
  webhooks = PUBLIC_ONLY,
  cloud,
  signals = noLive,
  publicUrl,
  secret,
  lifecycleMs = LIFECYCLE_EVERY_MS,
  pollMs = POLL_MS,
  retryMs = RETRY_MS,
  deleteTimeoutMs = DELETE_TIMEOUT_MS,
  mailTimeoutMs = MAIL_TIMEOUT_MS,
}: WorkerOptions): Worker {
  const stopping = new AbortController();
  const bounded =
    mailer === undefined ? undefined : boundedMailer(mailer, stopping.signal, mailTimeoutMs);
  const cloudStep = cloudWorkerStep(cloud, { db, logger, publicUrl, secret, signals });
  const channels = { push: push !== undefined, email: mailer !== undefined };
  let wake = () => {};

  const send = async (
    plan: Exclude<AlertPlan, { channel: "later" }>,
  ): Promise<"sent" | "skipped"> => {
    if (plan.channel === "push") {
      if (push === undefined) return "skipped";
      const result = await sendToOperator(db, push, plan.operatorId, plan.payload, stopping.signal);
      // A retry would alert the working devices again, so one device reaching the operator is enough.
      if (result.sent === 0 && result.failed > 0) {
        throw new Error(`${result.failed} push devices failed`);
      }
      return result.sent > 0 ? "sent" : "skipped";
    }
    if (bounded === undefined) return "skipped";
    const headers =
      plan.stopUrl === undefined
        ? undefined
        : {
            "list-unsubscribe": `<${plan.stopUrl}>`,
            "list-unsubscribe-post": "List-Unsubscribe=One-Click",
          };
    await bounded.send(plan.to, plan.subject, plan.text, headers);
    return "sent";
  };

  const deliver = async (row: ClaimedDelivery) => {
    // This row's earlier claims ended in crashes, so it does not get another.
    if (row.attempts > MAX_ATTEMPTS) {
      logger.error({ deliveryId: row.id }, "alert stopped after repeated crashes");
      await finishDelivery(db, row, "failed");
      return;
    }
    try {
      const plan = await planDelivery(db, row, { publicUrl, secret });
      if (plan?.channel === "later") {
        await postponeDelivery(db, row, plan.until);
        return;
      }
      await finishDelivery(db, row, plan === null ? "skipped" : await send(plan));
    } catch (err) {
      if (stopping.signal.aborted) {
        await releaseDelivery(db, row);
      } else if (row.attempts >= MAX_ATTEMPTS) {
        logger.error({ err, deliveryId: row.id }, "alert failed for good");
        await finishDelivery(db, row, "failed");
      } else {
        logger.warn({ err, deliveryId: row.id }, "alert failed and will retry");
        await retryDelivery(db, row, retryMs);
      }
    }
  };

  const removeFile = async (from: ObjectStore, row: ClaimedDeletion) => {
    try {
      // Bounded, because alerts go out in this same pass, and a stalled store must not hold them.
      const timeout = AbortSignal.timeout(deleteTimeoutMs);
      await Promise.race([from.delete(row.storageKey, timeout), aborted(timeout)]);
      await finishDeletion(db, row);
    } catch (err) {
      logger.warn({ err, deletionId: row.id }, "a file delete failed and will retry");
      await retryDeletion(db, row, retryMs);
    }
  };

  // A delivery holds no connection while it sends, so slots only bound the open requests.
  const inFlight = new Set<Promise<void>>();
  const startDeliveries = async () => {
    const free = IN_FLIGHT - inFlight.size;
    if (free <= 0) return false;
    const rows = await claimDeliveries(db, free, CLAIM_MS);
    for (const row of rows) {
      const job: Promise<void> = deliver(row)
        .catch((err) => logger.error({ err, deliveryId: row.id }, "alert could not finish"))
        .finally(() => {
          inFlight.delete(job);
          wake();
        });
      inFlight.add(job);
    }
    return rows.length > 0;
  };

  /**
   * Runs one stage, which is busy when it answers true. A failure is logged and skips only this
   * stage, never the ones after it.
   */
  const stage = async (name: string, work: () => Promise<boolean> | Promise<void>) => {
    try {
      return (await work()) === true;
    } catch (err) {
      logger.error({ err, stage: name }, "worker stage failed");
      return false;
    }
  };

  const fanOut = async () => {
    let busy = false;
    for (let done = 0; done < FAN_OUT_BATCH && !stopping.signal.aborted; done++) {
      if (!(await fanOutOne(db, channels))) break;
      busy = true;
    }
    return busy;
  };

  const fanOutWebhooks = async () => {
    let busy = false;
    for (let done = 0; done < FAN_OUT_BATCH && !stopping.signal.aborted; done++) {
      if (!(await fanOutWebhooksOne(db))) break;
      busy = true;
    }
    return busy;
  };

  // Webhooks get their own slots, so a slow receiver never holds an alert back.
  const hooksInFlight = new Set<Promise<void>>();
  const startWebhooks = async () => {
    const free = IN_FLIGHT - hooksInFlight.size;
    if (free <= 0) return false;
    const rows = await claimWebhookDeliveries(db, free, CLAIM_MS);
    for (const row of rows) {
      const work =
        row.attempts > WEBHOOK_MAX_ATTEMPTS
          ? abandonWebhook(db, row)
          : deliverWebhook(db, row, {
              images,
              policy: webhooks,
              retryMs,
              stopping: stopping.signal,
            });
      const job: Promise<void> = work
        .catch((err) => logger.error({ err, deliveryId: row.id }, "webhook could not finish"))
        .finally(() => {
          hooksInFlight.delete(job);
          wake();
        });
      hooksInFlight.add(job);
    }
    return rows.length > 0;
  };

  const deleteFiles = async () => {
    if (store === undefined) return false;
    const deletions = await claimDeletions(db, BATCH, CLAIM_MS);
    await Promise.all(deletions.map((row) => removeFile(store, row)));
    return deletions.length > 0;
  };

  let beatAt = 0;
  const heartbeat = async () => {
    if (Date.now() < beatAt) return;
    await recordHeartbeat(db);
    beatAt = Date.now() + HEARTBEAT_EVERY_MS;
  };

  const running = (async () => {
    let pruneAt = 0;
    let lifecycleAt = 0;
    while (!stopping.signal.aborted) {
      let busy = await stage("fan-out", fanOut);
      busy = (await stage("webhook fan-out", fanOutWebhooks)) || busy;
      if (!stopping.signal.aborted) {
        busy = (await stage("deliveries", startDeliveries)) || busy;
        busy = (await stage("webhooks", startWebhooks)) || busy;
        busy = (await stage("file deletions", deleteFiles)) || busy;
      }
      if (Date.now() >= pruneAt) {
        pruneAt = Date.now() + PRUNE_EVERY_MS;
        await stage("prune", async () => {
          await pruneOnce(db, new Date(Date.now() - RETENTION_MS));
        });
      }
      if (Date.now() >= lifecycleAt) {
        lifecycleAt = Date.now() + lifecycleMs;
        // The cloud step keeps its own claim time, sized for slow Stripe calls and emails.
        await stage("cloud", async () => cloudStep?.({ mailer: bounded }));
        // Its images go through the deletions above, and the workspace row after them.
        await stage("purge", async () => {
          await purgeDeletedWorkspaces(db);
        });
      }
      await stage("heartbeat", heartbeat);
      if (busy || stopping.signal.aborted) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  logger.info("worker started");
  return {
    async stop() {
      stopping.abort(new Error("The worker is stopping"));
      wake();
      await Promise.race([
        running.then(() => Promise.allSettled([...inFlight, ...hooksInFlight])),
        delay(STOP_WAIT_MS, undefined, { ref: false }),
      ]);
      logger.info("worker stopped");
    },
  };
}
