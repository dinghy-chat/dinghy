import type { components, paths } from "./openapi.ts";
import { DinghyError } from "./request.ts";

type Schemas = components["schemas"];

/** Every webhook type, from the API's own list. */
export type WebhookType = NonNullable<
  paths["/v1/operator/workspaces/{workspaceId}/webhooks"]["post"]["requestBody"]
>["content"]["application/json"]["events"][number];

type MessageType = Extract<WebhookType, `message.${string}`>;
type OutboundType = Extract<WebhookType, `outbound_message.${string}`>;
type CampaignType = Extract<WebhookType, `campaign.${string}`>;
type ConversationType = Exclude<
  WebhookType,
  MessageType | OutboundType | CampaignType | "conversation.labeled" | "draft.change_requested"
>;

interface ConversationData {
  conversation: Schemas["Conversation"];
}

/** The `data` of each webhook type, in the same shapes as the operator API. */
type DataOf<T extends WebhookType> = T extends MessageType
  ? ConversationData & { message: Schemas["InboxMessage"] }
  : T extends OutboundType
    ? { outboundMessage: Schemas["OutboundMessage"] }
    : T extends CampaignType
      ? { campaign: Schemas["Campaign"] }
      : T extends "draft.change_requested"
        ? { changeRequest: Schemas["DraftChangeRequest"]; draft: Schemas["Draft"] }
        : T extends "conversation.labeled"
          ? ConversationData & { label: Schemas["Label"]; action: "added" | "removed" }
          : T extends ConversationType
            ? ConversationData
            : never;

/** One event, as the events stream yields it. */
export type StreamEvent = {
  [T in WebhookType]: { id: string; type: T; data: DataOf<T> };
}[WebhookType];

/** One webhook request's body. `webhook.test` is the body that Settings' test sends. */
export type WebhookEvent =
  | {
      [T in WebhookType]: {
        id: string;
        type: T;
        createdAt: string;
        workspaceId: string;
        data: DataOf<T>;
      };
    }[WebhookType]
  | {
      id: string;
      type: "webhook.test";
      createdAt: string;
      workspaceId: string;
      data: Record<string, never>;
    };

type Headers = globalThis.Headers | Record<string, string | string[] | undefined>;

/** A received webhook: a fetch `Request`, or its raw body and headers, as Node gives them. */
export type Received = Request | { body: string | Uint8Array; headers: Headers };

// The server's tolerance for its own clock and for a slow delivery.
const TOLERANCE_SECONDS = 300;
const SIGNATURE = /^t=(\d+),v1=([0-9a-f]{64})$/;

function header(headers: Headers, name: string): string | null {
  if (headers instanceof globalThis.Headers) return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return (Array.isArray(found) ? found[0] : found) ?? null;
}

const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const refused = (message: string) => new DinghyError(400, "bad_signature", message);

/** Checks `Dinghy-Signature` with the webhook's secret, and returns the parsed body. */
export async function verifyWebhook(received: Received, secret: string): Promise<WebhookEvent> {
  const bytes =
    received instanceof Request
      ? new Uint8Array(await received.arrayBuffer())
      : typeof received.body === "string"
        ? new TextEncoder().encode(received.body)
        : received.body;
  const match = SIGNATURE.exec(header(received.headers, "dinghy-signature") ?? "");
  if (match === null) throw refused("The Dinghy-Signature header is missing or malformed.");
  const [, timestamp = "", digest = ""] = match;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw refused("The webhook's timestamp is more than 5 minutes away from now.");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  // `verify` compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, hexBytes(digest), signed))) {
    throw refused("The webhook's signature does not match its secret.");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as WebhookEvent;
}
