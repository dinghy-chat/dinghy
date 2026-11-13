import { createHmac, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import type { App } from "./app.ts";
import { errorAnswer } from "./errors.ts";
import {
  BAD_SIGNATURE,
  EMAIL_MAX_BYTES,
  EMAIL_MAX_MB,
  type EmailIntake,
  OK,
  type Received,
  SIGNATURE_TOLERANCE_MINUTES,
} from "./inbound-email.ts";
import { SIGNATURE_TOLERANCE_SECONDS } from "./setup-code.ts";

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
  const digest = createHmac("sha256", secret)
    .update(`v1=${Number(time)}\n`)
    .update(body)
    .digest();
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
  const call = async (method: string, emailId: string, action = "", body?: unknown) => {
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
    // 404 is a message that an earlier delivery of the same event took and deleted, and 413 is a
    // download over Shipmail's own limit.
    if (!response.ok && response.status !== 404 && response.status !== 413) {
      await drain(response);
      throw new Error(`Shipmail answered ${response.status} to ${method} ${action || "message"}`);
    }
    return response;
  };
  return {
    /** The email as it arrived, "gone" once deleted, or "too_large" past the intake's limit. */
    async raw(emailId: string): Promise<Buffer | "gone" | "too_large"> {
      const response = await call("GET", emailId, "/raw");
      if (response.status === 404 || response.status === 413) {
        await drain(response);
        return response.status === 404 ? "gone" : "too_large";
      }
      return (await readUpTo(response, EMAIL_MAX_BYTES)) ?? "too_large";
    },
    /** Shipmail deletes only a message in Trash, so it goes there first. */
    async remove(emailId: string): Promise<void> {
      await drain(await call("POST", emailId, "/move", { target_role: "trash" }));
      await drain(await call("DELETE", emailId));
    },
  };
}

type Inbox = ReturnType<typeof shipmailInbox>;
type Later = Extract<Received, { status: 429 | 503 }>;

/**
 * Takes the email into the conversation, then deletes it from the mailbox, so the mailbox keeps
 * only what still has to come in. An email the intake refuses for good is deleted too, as the raw
 * route's forwarder rejects it. One the intake asks to send later stays for Shipmail's retry.
 */
async function take(intake: EmailIntake, inbox: Inbox, emailId: string) {
  const raw = await inbox.raw(emailId);
  if (raw === "gone") return null;
  if (raw !== "too_large") {
    const received = await intake.receive(raw);
    if (received.status === 429 || received.status === 503) return received;
  }
  await inbox.remove(emailId);
  return null;
}

const shipmailRoute = createRoute({
  method: "post",
  path: PATH,
  summary: "Receive a visitor's reply by email, from Shipmail",
  description: `For Shipmail's webhook, and only on a server with \`INBOUND_EMAIL_DOMAIN\`, \`SHIPMAIL_API_KEY\`, \`SHIPMAIL_WEBHOOK_SECRET\` and \`SHIPMAIL_MAILBOX_ID\` set. The body is Shipmail's JSON event, up to ${EVENT_MAX_BYTES / 1024} KB. \`X-Shipmail-Signature\` is the hex HMAC-SHA256 of "v1=<X-Shipmail-Timestamp>\\n<body>" under SHIPMAIL_WEBHOOK_SECRET, and the time must be within ${SIGNATURE_TOLERANCE_MINUTES} minutes. Any event but \`message.received\` in SHIPMAIL_MAILBOX_ID gets a 200 and is ignored. For that one, the server downloads the email, up to ${EMAIL_MAX_MB} MB, and takes it as \`POST /v1/inbound-email\` does. It then deletes the message from the mailbox: once taken, once dropped as an automatic answer, and once refused for good, such as for an unknown address. Shipmail retries any other answer, and a retry adds nothing.`,
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
      "too_many_requests: too many emails to this address in an hour. The message stays",
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
  app.use(PATH, bodyLimit({ maxSize: EVENT_MAX_BYTES }));
  app.openapi(shipmailRoute, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const time = c.req.header("x-shipmail-timestamp") ?? "";
    const signature = c.req.header("x-shipmail-signature") ?? "";
    if (!isSigned(settings.webhookSecret, time, signature, body)) {
      return c.json(BAD_SIGNATURE, 401);
    }
    const emailId = receivedEmailId(body, settings.mailboxId);
    if (emailId === null) return c.json(OK, 200);
    const later: Later | null = await intake.hold(() => take(intake, inbox, emailId));
    if (later === null) return c.json(OK, 200);
    c.header("retry-after", String(later.retryAfterSeconds));
    return c.json(later.body, later.status);
  });
}
