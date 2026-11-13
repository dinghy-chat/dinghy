import { createHmac, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { App } from "./app.ts";
import type { Database } from "./db/tenant.ts";
import { errorAnswer, failure } from "./errors.ts";
import {
  BAD_SIGNATURE,
  EMAIL_MAX_BYTES,
  EMAIL_MAX_MB,
  type EmailIntake,
  MESSAGES_PER_ADDRESS_PER_HOUR,
  OK,
  parseReplyAddress,
  REPLY_ADDRESS_DAYS,
  type Received,
  receivedAnswer,
} from "./inbound-email.ts";
import { SIGNATURE_TOLERANCE_MINUTES, SIGNATURE_TOLERANCE_SECONDS } from "./setup-code.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

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
/** The sweep leaves a younger message to its webhook delivery, which Shipmail may still retry. */
const FRESH_MS = 10 * MINUTE_MS;
/**
 * Messages on each page of the sweep's listing. Shipmail lists each message with its whole body, so
 * a page is read up to PAGE_MAX_BYTES, and one that is larger is read again a message at a time.
 */
const PAGE_SIZE = 10;
const PAGE_MAX_BYTES = 64 * 1024 * 1024;
/** The name of the session lock that keeps the sweep to one instance at a time. */
const SWEEP_LOCK = "shipmail-sweep";
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

const recipients = z.array(z.object({ email: z.string().nullable() })).nullable();

/** One page of the mailbox's messages, with only the fields the sweep reads. */
const inboxPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      to: recipients,
      cc: recipients,
      received_at: z.coerce.date(),
    }),
  ),
  pagination: z.object({ next_cursor: z.string().nullable() }),
});

type InboxPage = z.infer<typeof inboxPage>;

/** The inbox calls the receiver makes, on the one mailbox in the settings. */
function shipmailInbox({ apiBase, apiKey, mailboxId }: ShipmailInbound) {
  const messagesUrl = `${apiBase}/mailboxes/${encodeURIComponent(mailboxId)}/inbox/messages`;
  const call = async (
    method: string,
    path: string,
    { body, allowedStatuses = [] }: { body?: unknown; allowedStatuses?: number[] } = {},
  ) => {
    const response = await fetch(`${messagesUrl}${path}`, {
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
      throw new Error(`Shipmail answered ${response.status} to ${method} ${path.split("?")[0]}`);
    }
    return response;
  };
  const one = (emailId: string, action = "") => `/${encodeURIComponent(emailId)}${action}`;
  return {
    /**
     * The messages received before `before`, a page at a time, or null when the cursor's message
     * left the list, as a webhook's delete meanwhile can make it. The next sweep starts over.
     */
    async page(before: Date, cursor: string | null) {
      for (const size of [PAGE_SIZE, 1]) {
        const query = new URLSearchParams({ before: before.toISOString(), limit: String(size) });
        if (cursor !== null) query.set("cursor", cursor);
        const response = await call("GET", `?${query}`, { allowedStatuses: [409] });
        if (response.status === 409) {
          await drain(response);
          return null;
        }
        const body = await readUpTo(response, PAGE_MAX_BYTES);
        if (body !== null) return inboxPage.parse(JSON.parse(body.toString("utf8")));
      }
      throw new Error("One message's listing is larger than the sweep reads");
    },
    /** The email as it arrived, "gone" once deleted, or "too_large" past the intake's limit. */
    async raw(emailId: string): Promise<Buffer | "gone" | "too_large"> {
      // 404 is a message that an earlier delivery of the same event took and deleted, and 413 is a
      // download over Shipmail's own limit.
      const response = await call("GET", one(emailId, "/raw"), { allowedStatuses: [404, 413] });
      if (response.status === 404 || response.status === 413) {
        await drain(response);
        return response.status === 404 ? "gone" : "too_large";
      }
      return (await readUpTo(response, EMAIL_MAX_BYTES)) ?? "too_large";
    },
    /** Shipmail deletes only a message in Trash, so it goes there first. A gone one is done. */
    async remove(emailId: string): Promise<void> {
      const moved = await call("POST", one(emailId, "/move"), {
        body: { target_role: "trash" },
        allowedStatuses: [404],
      });
      await drain(moved);
      if (moved.status === 404) return;
      await drain(await call("DELETE", one(emailId), { allowedStatuses: [404] }));
    },
  };
}

type Inbox = ReturnType<typeof shipmailInbox>;

/** What became of an email: in, refused for good, gone or kept, or left for a retry. */
type Taken = { status: 200 } | Extract<Received, { status: 429 | 503 }>;
const DONE = { status: 200 } as const;

/**
 * Takes the email into the conversation, then deletes it from the mailbox, so the mailbox keeps
 * only what still has to come in. An email refused for good, such as for a blocked visitor or an
 * unknown address, is deleted too, as the raw route's forwarder rejects it. One the intake asks to
 * send later stays for a retry. One for a closed workspace stays in the mailbox, as a delete would
 * lose it, and the sweep takes it once the workspace opens again.
 */
async function take(intake: EmailIntake, inbox: Inbox, emailId: string): Promise<Taken> {
  const raw = await inbox.raw(emailId);
  if (raw === "gone") return DONE;
  if (raw !== "too_large") {
    const received = await intake.receive(raw);
    if (received.status === 429 || received.status === 503) return received;
    if ("isWorkspaceClosed" in received) return DONE;
  }
  await inbox.remove(emailId);
  return DONE;
}

/** Of these workspaces, the ones that refuse email until they open again: unpaid or suspended. */
async function closedWorkspaces(db: Database, workspaceIds: string[]): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  const result = await db.execute<{ id: string }>(sql`
    SELECT id FROM unnest(${sql.param(workspaceIds)}::uuid[]) AS id
    WHERE workspace_access(id) IN ('waiting_payment', 'suspended', 'read_only')`);
  return new Set(result.rows.map((row) => row.id));
}

interface SweepOptions {
  /** The app's database, which the intake writes the messages with. */
  db: Database;
  intake: EmailIntake;
  domain: string;
  settings: ShipmailInbound;
  logger: Logger;
}

/**
 * The worker's sweep of the mailbox, which holds only the emails still to come in: those kept for
 * a closed workspace, and any whose webhook delivery failed. It takes each one as the webhook does,
 * one at a time, and deletes one older than REPLY_ADDRESS_DAYS, whose address has expired. It
 * skips a message that is still in its webhook delivery, and one whose workspace is still closed,
 * without downloading it. One sweep runs at a time across instances.
 */
export function mailboxSweep({ db, intake, domain, settings, logger }: SweepOptions) {
  const inbox = shipmailInbox(settings);
  // A visitor can put the reply address in Cc, as a mail app's "Reply all" can. One only in Bcc or
  // Delivered-To names no workspace here, so it is downloaded on each sweep while its workspace is
  // closed. That is rare, and the take keeps it, so nothing is lost.
  const workspaceOf = ({ to, cc }: InboxPage["data"][number]) =>
    [...(to ?? []), ...(cc ?? [])]
      .map(({ email }) => parseReplyAddress(email ?? "", domain))
      .find((target) => target !== null)?.workspaceId;

  const sweepOne = async (closed: Set<string>, message: InboxPage["data"][number]) => {
    if (message.received_at.getTime() < Date.now() - REPLY_ADDRESS_DAYS * DAY_MS) {
      await inbox.remove(message.id);
      return;
    }
    const workspaceId = workspaceOf(message);
    if (workspaceId !== undefined && closed.has(workspaceId)) return;
    await intake.hold(() => take(intake, inbox, message.id));
  };

  const sweepPage = async ({ data }: InboxPage, stopping: AbortSignal) => {
    const workspaceIds = data.map(workspaceOf);
    const closed = await closedWorkspaces(
      db,
      workspaceIds.filter((id) => id !== undefined),
    );
    for (const message of data) {
      if (stopping.aborted) return;
      // One message that keeps failing must not hold back the ones after it.
      await sweepOne(closed, message).catch((err: unknown) =>
        logger.warn({ err, emailId: message.id }, "a Shipmail email failed and will retry"),
      );
    }
  };

  const sweep = async (stopping: AbortSignal) => {
    const before = new Date(Date.now() - FRESH_MS);
    let page = await inbox.page(before, null);
    while (page !== null && !stopping.aborted) {
      // The next page first: its cursor names a message of this page, which a delete could remove.
      const cursor = page.pagination.next_cursor;
      const next = cursor === null ? null : await inbox.page(before, cursor);
      await sweepPage(page, stopping);
      page = next;
    }
  };

  return async (stopping: AbortSignal): Promise<void> => {
    const client = await db.$client.connect();
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [SWEEP_LOCK],
      );
      if (lock.rows[0]?.locked === true) await sweep(stopping);
    } finally {
      // Closing the connection frees the lock, even after a failure.
      client.release(true);
    }
  };
}

const shipmailRoute = createRoute({
  method: "post",
  path: PATH,
  summary: "Receive a visitor's reply by email, from Shipmail",
  description: `For Shipmail's webhook, and only on a server with \`INBOUND_EMAIL_DOMAIN\`, \`SHIPMAIL_API_KEY\`, \`SHIPMAIL_WEBHOOK_SECRET\` and \`SHIPMAIL_MAILBOX_ID\` set. The body is Shipmail's JSON event, up to ${EVENT_MAX_BYTES / 1024} KB. \`X-Shipmail-Signature\` is the hex HMAC-SHA256 of "v1=<X-Shipmail-Timestamp>\\n<body>" under SHIPMAIL_WEBHOOK_SECRET, and the time must be within ${SIGNATURE_TOLERANCE_MINUTES} minutes. Any event but \`message.received\` in SHIPMAIL_MAILBOX_ID gets a 200 and is ignored. For that one, the server downloads the email, up to ${EMAIL_MAX_MB} MB, and takes it as \`POST /v1/inbound-email\` does. It then deletes the message from the mailbox: once taken, once dropped as an automatic answer, and once refused for good, such as for an unknown address or a blocked visitor. An email for an unpaid or suspended workspace stays in the mailbox with a 200. It comes in by itself within a minute or two of the workspace opening again, and is deleted from the mailbox after ${REPLY_ADDRESS_DAYS} days if it never does. Shipmail retries any other answer, and a retry adds nothing. The worker also sweeps the mailbox once a minute, so a reply whose webhook delivery failed still comes in, about 10 minutes after it arrived.`,
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
  intake: EmailIntake,
  settings: ShipmailInbound,
): void {
  const inbox = shipmailInbox(settings);
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
    return receivedAnswer(c, await intake.hold(() => take(intake, inbox, emailId)));
  });
}
