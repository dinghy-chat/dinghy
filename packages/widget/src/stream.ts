// The widget and the operator app read the same server-sent event stream, so they share this.

/** Retry-After in milliseconds, or 30 seconds when it is missing or not a number of seconds. */
export function retryAfterMs(header: string | null): number {
  return (header !== null && /^\d+$/.test(header) ? Number(header) : 30) * 1000;
}

interface StreamHandlers<T> {
  /** Each event named `name`, with its parsed data and its cursor. */
  data(value: T, cursor: string): void;
  ready(cursor: string | null): void;
  resync(cursor: string): void;
  /** Something live and unstored, on an operator's stream. */
  notice?(value: unknown): void;
}

/**
 * Reads the stream until it ends, and resolves with the reason the server gave in its close
 * event, or null if the connection dropped. EventSource cannot send a bearer token, so this reads
 * a fetch response.
 */
export async function readStream<T>(
  response: Response,
  name: string,
  handlers: StreamHandlers<T>,
): Promise<string | null> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) return null;
    buffer += value;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (key: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${key}: `))
          ?.slice(key.length + 2);
      const event = field("event");
      const data = field("data");
      if (event === undefined || data === undefined) continue;
      const parsed = JSON.parse(data);
      if (event === name) handlers.data(parsed, field("id") ?? "");
      if (event === "ready") handlers.ready(parsed.cursor);
      if (event === "resync") handlers.resync(parsed.cursor);
      if (event === "notice") handlers.notice?.(parsed);
      if (event === "close") return parsed.reason;
    }
  }
  return null;
}
