import { DinghyError, errorOf, type Fetch, RETRY_STATUSES, wait, withRetries } from "./request.ts";
import type { StreamEvent, WebhookType } from "./webhooks.ts";

/** An event, or `resync`: the cursor was too old, so read the open conversations again. */
export type StreamItem = StreamEvent | { id: string; type: "resync"; data: Record<string, never> };

export interface StreamOptions {
  /** The types to receive. All by default. */
  types?: WebhookType[];
  /** The position to resume after, from an earlier event's `id`. With none, it starts now. */
  after?: string;
}

interface Client {
  baseUrl: string;
  apiKey: string;
  fetch: Fetch;
}

interface Message {
  event: string;
  id: string | null;
  data: string;
}

// Between connections, so a server that is down or closes at once is not called in a tight loop.
const RECONNECT_DELAY_MS = 1000;

/** The messages in one block of server-sent event lines. Comments, such as pings, are skipped. */
function parseBlock(block: string): Message {
  const message: Message = { event: "message", id: null, data: "" };
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === 0) continue;
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") message.event = value;
    else if (field === "id") message.id = value;
    else if (field === "data")
      message.data = message.data === "" ? value : `${message.data}\n${value}`;
  }
  return message;
}

/** The messages of a response body, as they arrive. */
async function* messages(body: ReadableStream<Uint8Array>): AsyncGenerator<Message> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffered.indexOf("\n\n");
      while (end !== -1) {
        yield parseBlock(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function connect(client: Client, options: StreamOptions, lastId: string | undefined) {
  const url = new URL("/v1/events", client.baseUrl);
  if (options.types !== undefined) url.searchParams.set("types", options.types.join(","));
  if (options.after !== undefined) url.searchParams.set("after", options.after);
  const headers: Record<string, string> = {
    authorization: `Bearer ${client.apiKey}`,
    accept: "text/event-stream",
  };
  if (lastId !== undefined) headers["last-event-id"] = lastId;
  const response = await withRetries(client.fetch, { method: "get", url: url.href, headers }, true);
  if (!response.ok || response.body === null) throw await errorOf(response);
  return response.body;
}

/** What one message means: an item to yield, a cursor to keep, or the end of this connection. */
function read(message: Message): StreamItem | "skip" | "reconnect" {
  if (message.event === "close") {
    const { reason } = JSON.parse(message.data) as { reason: string };
    if (reason === "unauthorized") {
      throw new DinghyError(401, "unauthorized", "The API key is not valid or was revoked.");
    }
    return "reconnect";
  }
  if (message.event === "resync") {
    const { cursor } = JSON.parse(message.data) as { cursor: string };
    return { id: cursor, type: "resync", data: {} };
  }
  if (message.id === null) return "skip";
  const { type, data } = JSON.parse(message.data) as Pick<StreamEvent, "type" | "data">;
  return { id: message.id, type, data } as StreamEvent;
}

/**
 * The workspace's events, for as long as the caller reads them. It reconnects after the server
 * ends a stream or a connection drops, and resumes after the last event with `Last-Event-ID`.
 */
export async function* streamEvents(
  client: Client,
  options: StreamOptions,
): AsyncGenerator<StreamItem> {
  let lastId: string | undefined;
  for (;;) {
    try {
      for await (const message of messages(await connect(client, options, lastId))) {
        const item = read(message);
        if (item === "reconnect") break;
        if (item === "skip") continue;
        lastId = item.id;
        yield item;
      }
    } catch (error) {
      if (error instanceof DinghyError && !RETRY_STATUSES.has(error.status)) throw error;
    }
    await wait(RECONNECT_DELAY_MS);
  }
}
