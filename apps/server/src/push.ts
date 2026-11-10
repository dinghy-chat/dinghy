import { generateRequestDetails } from "web-push";

interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** The service worker sets this as the notification's tag, so a repeated send collapses. */
  tag: string;
  url: string;
}

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  /** A real contact, as mailto: or https:, that push services can use. */
  subject: string;
}

/** A 404 or 410 means the browser dropped this subscription, so it can go. */
type PushResult = "sent" | "gone" | "failed";

export interface Push {
  publicKey: string;
  send(target: PushTarget, payload: PushPayload, signal?: AbortSignal): Promise<PushResult>;
}

const SEND_TIMEOUT_MS = 15_000;
// A phone that is off for a day still gets the alert when it returns.
const TTL_SECONDS = 86_400;

// A browser gives its own service's URL, but an operator could post any URL here. The server calls
// it, so an open list would let a customer reach private addresses on the server's network.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** A browser's keys are a P-256 public key of 65 bytes and an auth secret of 16 bytes. */
export function isPushKeys(p256dh: string, auth: string): boolean {
  return (
    Buffer.from(p256dh, "base64url").length === 65 && Buffer.from(auth, "base64url").length === 16
  );
}

export function isPushEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return url.protocol === "https:" && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

export function createPush(keys: PushKeys, request: typeof fetch = fetch): Push {
  return {
    publicKey: keys.publicKey,
    async send(target, payload, signal) {
      const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
      try {
        // Inside the try, because a key it cannot use throws, and this device must fail alone.
        const details = generateRequestDetails(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          {
            TTL: TTL_SECONDS,
            urgency: "high",
            vapidDetails: {
              subject: keys.subject,
              publicKey: keys.publicKey,
              privateKey: keys.privateKey,
            },
          },
        );
        const response = await request(details.endpoint, {
          method: details.method,
          headers: details.headers as Record<string, string>,
          body: details.body as unknown as BodyInit,
          redirect: "error",
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) return "gone";
        return response.ok ? "sent" : "failed";
      } catch (error) {
        // A stopping worker gives its claim back, so this must not count as an attempt.
        if (signal?.aborted) throw error;
        return "failed";
      }
    },
  };
}
