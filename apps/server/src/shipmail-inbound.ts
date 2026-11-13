import { createHmac, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { App } from "./app.ts";
import { shipmailHeldEmail } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, failure } from "./errors.ts";
import {
  BAD_SIGNATURE,
  EMAIL_MAX_BYTES,
  EMAIL_MAX_MB,
  type EmailIntake,
  MESSAGES_PER_ADDRESS_PER_HOUR,
  OK,
  REPLY_ADDRESS_DAYS,
  type Received,
  receivedAnswer,
} from "./inbound-email.ts";
import { SIGNATURE_TOLERANCE_MINUTES, SIGNATURE_TOLERANCE_SECONDS } from "./setup-code.ts";
import { MINUTE_MS } from "./time.ts";

/** Shipmail's webhook for the mailbox that gets the replies, and the API key that reads it. */
export interface ShipmailInbound {
  /** Shipmail's API, with no slash at the end. */
  apiBase: string;
  apiKey: string;
  webhookSecret: string;
  mailboxId: string;
}

const PATH = "/v1/inbound-email/shipmail";
/** An event carries addresses, a subject and verdicts, never the email's body. */
const EVENT_MAX_BYTES = 256 * 1024;
/** Each call to Shipmail. A 25 MB download takes a few seconds on a working link. */
const SHIPMAIL_TIMEOUT_MS = 30_000;
/** Kept emails one worker pass takes at once, each up to EMAIL_MAX_BYTES. */
const HELD_EMAILS_AT_ONCE = 4;
/**
 * How long a claimed kept email stays with one worker, and so the wait before a failed one is tried
 * again. A take makes up to three Shipmail calls of SHIPMAIL_TIMEOUT_MS each.
 */
const HELD_CLAIM_MS = 5 * MINUTE_MS;
const EVENT_TOO_LARGE = failure("too_large", `An event can be up to ${EVENT_MAX_BYTES / 1024} KB.`);

// Only what the receiver reads. Shipmail adds fields to events, and they pass.
const receivedEvent = z.object({
  event_type: z.literal("message.received"),
  data: z.object({ mailbox_id: z.string(), email_id: z.string().min(1) }),
});

/**
 * `X-Shipmail-Signature` is the hex HMAC-SHA256 of "v1=<time>\n<body>", with the time in
 * `X-Shipmail-Timestamp`.
 */
function isSigned(secret: string, time: string, signature: string, body: Uint8Array): boolean {
  if (!/^\d{1,12}$/.test(time) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Date.now() / 1000 - Number(time)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const digest = createHmac("sha256", secret).update(`v1=${time}\n`).update(body).digest();
  // The pattern fixes the signature at 32 bytes, so timingSafeEqual never throws on length.
  return timingSafeEqual(digest, Buffer.from(signature, "hex"));
}

/** The message's ID when the event is a message received in this mailbox, else null. */
function receivedEmailId(body: Uint8Array, mailboxId: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  const event = receivedEvent.safeParse(json);
  if (!event.success || event.data.data.mailbox_id !== mailboxId) return null;
  return event.data.data.email_id;
}

/** Frees the connection of an answer whose body nothing reads. */
const drain = async (response: Response) => {
  await response.body?.cancel();
};

/** The body up to `maxBytes`, or null past it. */
async function readUpTo(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await drain(response);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The inbox calls the receiver makes, on the one mailbox in the settings. */
function shipmailInbox({ apiBase, apiKey, mailboxId }: ShipmailInbound) {
  const call = async (
    method: string,
    emailId: string,
    action: string,
    { body, allowedStatuses = [] }: { body?: unknown; allowedStatuses?: number[] } = {},
  ) => {
    const path = `/mailboxes/${encodeURIComponent(mailboxId)}/inbox/messages/${encodeURIComponent(emailId)}${action}`;
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(SHIPMAIL_TIMEOUT_MS),
    });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      await drain(response);
      throw new Error(`Shipmail answered ${response.status} to ${method} ${action || "message"}`);
    }
    return response;
  };
  return {
    /** The email as it arrived, "gone" once deleted, or "too_large" past the intake's limit. */
    async raw(emailId: string): Promise<Buffer | "gone" | "too_large"> {
      // 404 is a message that an earlier delivery of the same event took and deleted, and 413 is a
      // download over Shipmail's own limit.
      const response = await call("GET", emailId, "/raw", { allowedStatuses: [404, 413] });
      if (response.status === 404 || response.status === 413) {
        await drain(response);
        return response.status === 404 ? "gone" : "too_large";
      }
      return (await readUpTo(response, EMAIL_MAX_BYTES)) ?? "too_large";
    },
    /** Shipmail deletes only a message in Trash, so it goes there first. A gone one is done. */
    async remove(emailId: string): Promise<void> {
      const moved = await call("POST", emailId, "/move", {
        body: { target_role: "trash" },
        allowedStatuses: [404],
      });
      await drain(moved);
      if (moved.status === 404) return;
      await drain(await call("DELETE", emailId, "", { allowedStatuses: [404] }));
    },
  };
}

interface Taker {
  /** The app's database, which the intake writes the messages with. */
  db: Database;
  intake: EmailIntake;
  inbox: ReturnType<typeof shipmailInbox>;
}

/**
 * What became of an email: in, refused for good or already gone; kept for a closed workspace; or
 * left for a retry.
 */
type Taken = { status: 200; isHeld: boolean } | Extract<Received, { status: 429 | 503 }>;

/**
 * Takes the email into the conversation, then deletes it from the mailbox, so the mailbox keeps
 * only what still has to come in. An email refused for good, such as for a blocked visitor or an
 * unknown address, is deleted too, as the raw route's forwarder rejects it. One the intake asks to
 * send later stays for Shipmail's retry. One for a closed workspace stays in the mailbox with a
 * 200, and a row for the worker, which takes it once the workspace opens again: Shipmail cannot
 * bounce it any more, a delete would lose it, and a retry could last weeks.
 */
async function take({ db, intake, inbox }: Taker, emailId: string): Promise<Taken> {
  const raw = await inbox.raw(emailId);
  const done = { status: 200 as const, isHeld: false };
  if (raw === "gone") return done;
  if (raw !== "too_large") {
    const received = await intake.receive(raw);
    if (received.status === 429 || received.status === 503) return received;
    if ("isWorkspaceClosed" in received) {
      const { workspaceId } = received;
      await withWorkspace(db, workspaceId, (tx) =>
        tx.insert(shipmailHeldEmail).values({ workspaceId, emailId }).onConflictDoNothing(),
      );
      return { status: 200, isHeld: true };
    }
  }
  await inbox.remove(emailId);
  return done;
}

interface HeldEmail {
  workspaceId: string;
  emailId: string;
  isExpired: boolean;
}

/**
 * Claims kept emails whose workspace takes them again, or refuses them for good once deleted, and
 * those kept past the reply address's lifetime. The claim moves each row's next try ahead.
 */
async function claimHeldEmails(workerDb: Database): Promise<HeldEmail[]> {
  const cutoff = sql`now() - make_interval(days => ${REPLY_ADDRESS_DAYS})`;
  const result = await workerDb.execute<{
    workspace_id: string;
    email_id: string;
    is_expired: boolean;
  }>(sql`
    WITH due AS MATERIALIZED (
      SELECT workspace_id, email_id FROM shipmail_held_email
      WHERE next_try_at <= now()
        AND (held_at < ${cutoff}
          OR workspace_access(workspace_id) IN ('active', 'waiting_cloud', 'deleted'))
      ORDER BY next_try_at
      LIMIT ${HELD_EMAILS_AT_ONCE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE shipmail_held_email AS row
    SET next_try_at = now() + ${HELD_CLAIM_MS}::float8 * interval '1 millisecond'
    FROM due
    WHERE row.workspace_id = due.workspace_id AND row.email_id = due.email_id
    RETURNING row.workspace_id, row.email_id, row.held_at < ${cutoff} AS is_expired`);
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    emailId: row.email_id,
    isExpired: row.is_expired,
  }));
}

interface HeldEmailOptions {
  /** The app's database, so the worker's own role writes no messages. */
  db: Database;
  workerDb: Database;
  intake: EmailIntake;
  settings: ShipmailInbound;
  logger: Logger;
}

/**
 * The worker's step for kept emails. It takes each claimed email as the webhook does, or deletes it
 * from the mailbox once it is 90 days old, then deletes its row. A row whose email is kept again, or
 * whose Shipmail call failed, stays for a later pass. Answers whether it claimed any.
 */
export function heldEmailStep({ db, workerDb, intake, settings, logger }: HeldEmailOptions) {
  const taker = { db, intake, inbox: shipmailInbox(settings) };
  const takeOne = async ({ workspaceId, emailId, isExpired }: HeldEmail) => {
    if (isExpired) {
      await taker.inbox.remove(emailId);
    } else {
      const taken = await intake.hold(() => take(taker, emailId));
      if (taken.status !== 200 || taken.isHeld) return;
    }
    await withWorkspace(workerDb, workspaceId, (tx) =>
      tx
        .delete(shipmailHeldEmail)
        .where(
          and(
            eq(shipmailHeldEmail.workspaceId, workspaceId),
            eq(shipmailHeldEmail.emailId, emailId),
          ),
        ),
    );
  };
  return async (): Promise<boolean> => {
    const rows = await claimHeldEmails(workerDb);
    await Promise.all(
      rows.map((row) =>
        takeOne(row).catch((err: unknown) =>
          logger.warn({ err, emailId: row.emailId }, "a kept email failed and will retry"),
        ),
      ),
    );
    return rows.length > 0;
  };
}

const shipmailRoute = createRoute({
  method: "post",
  path: PATH,
  summary: "Receive a visitor's reply by email, from Shipmail",
  description: `For Shipmail's webhook, and only on a server with \`INBOUND_EMAIL_DOMAIN\`, \`SHIPMAIL_API_KEY\`, \`SHIPMAIL_WEBHOOK_SECRET\` and \`SHIPMAIL_MAILBOX_ID\` set. The body is Shipmail's JSON event, up to ${EVENT_MAX_BYTES / 1024} KB. \`X-Shipmail-Signature\` is the hex HMAC-SHA256 of "v1=<X-Shipmail-Timestamp>\\n<body>" under SHIPMAIL_WEBHOOK_SECRET, and the time must be within ${SIGNATURE_TOLERANCE_MINUTES} minutes. Any event but \`message.received\` in SHIPMAIL_MAILBOX_ID gets a 200 and is ignored. For that one, the server downloads the email, up to ${EMAIL_MAX_MB} MB, and takes it as \`POST /v1/inbound-email\` does. It then deletes the message from the mailbox: once taken, once dropped as an automatic answer, and once refused for good, such as for an unknown address or a blocked visitor. An email for an unpaid or suspended workspace stays in the mailbox with a 200. It comes in by itself once the workspace opens again, within the worker's next passes, and is deleted from the mailbox after ${REPLY_ADDRESS_DAYS} days if the workspace never opens. Shipmail retries any other answer, and a retry adds nothing.`,
  responses: {
    200: {
      description: "Taken, dropped or refused for good, or an event the server ignores",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: errorAnswer(
      `bad_signature: the signature is missing, more than ${SIGNATURE_TOLERANCE_MINUTES} minutes old, or wrong`,
    ),
    413: errorAnswer(`too_large: the event is over ${EVENT_MAX_BYTES / 1024} KB`),
    429: errorAnswer(
      `too_many_requests: over ${MESSAGES_PER_ADDRESS_PER_HOUR} emails to this address in an hour. The message stays`,
    ),
    503: errorAnswer(
      "busy: too many emails are being received, or the image queue is full. The message stays",
    ),
  },
});

/** The route Shipmail posts its events to. It checks the signature before it parses the event. */
export function registerShipmailInbound(
  app: App,
  { db, intake }: { db: Database; intake: EmailIntake },
  settings: ShipmailInbound,
): void {
  const taker = { db, intake, inbox: shipmailInbox(settings) };
  app.use(
    PATH,
    bodyLimit({ maxSize: EVENT_MAX_BYTES, onError: (c) => c.json(EVENT_TOO_LARGE, 413) }),
  );
  app.openapi(shipmailRoute, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const time = c.req.header("x-shipmail-timestamp") ?? "";
    const signature = c.req.header("x-shipmail-signature") ?? "";
    if (!isSigned(settings.webhookSecret, time, signature, body)) {
      return c.json(BAD_SIGNATURE, 401);
    }
    const emailId = receivedEmailId(body, settings.mailboxId);
    if (emailId === null) return c.json(OK, 200);
    return receivedAnswer(c, await intake.hold(() => take(taker, emailId)));
  });
}
