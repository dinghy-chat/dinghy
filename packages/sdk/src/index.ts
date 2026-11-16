import { type StreamItem, type StreamOptions, streamEvents } from "./events.ts";
import { type HostUser, signHostToken } from "./identity.ts";
import {
  type Answer,
  call,
  type Fetch,
  type MethodOf,
  type RequestArgs,
  type WorkspacePath,
} from "./request.ts";
import {
  analytics,
  contacts,
  conversations,
  labels,
  outboundMessages,
  type Request,
  savedReplies,
  setup,
  webhookRoutes,
  workspace,
} from "./resources.ts";
import { type Received, verifyWebhook, type WebhookEvent } from "./webhooks.ts";

export type { StreamItem, StreamOptions } from "./events.ts";
export type { HostUser } from "./identity.ts";
export type { components, paths } from "./openapi.ts";
export type { ErrorCode, Fetch } from "./request.ts";
export { DinghyError } from "./request.ts";
export type { Received, StreamEvent, WebhookEvent, WebhookType } from "./webhooks.ts";

export interface DinghyOptions {
  /** The Dinghy server, such as https://chat.example.com. */
  url: string;
  /** A workspace API key, `dk_...`, or an OAuth access token, `dko_...`. */
  apiKey: string;
  /** The workspace's signing secret, for `identity.sign`. */
  signingSecret?: string | undefined;
  /** The workspace's public key, `wk_...`, for `identity.sign`. */
  publicKey?: string | undefined;
  /** A webhook's secret, for `webhooks.verify`. */
  webhookSecret?: string | undefined;
  /** Replaces the global `fetch`, such as in a test. */
  fetch?: Fetch;
}

const TOKEN = /^dko?_([0-9a-f-]{36})\./i;

/** The workspace a key or access token belongs to: the ID is the token's first part. */
function workspaceOf(apiKey: string): string {
  const workspaceId = TOKEN.exec(apiKey)?.[1];
  if (workspaceId === undefined) {
    throw new TypeError("apiKey must be a workspace API key, dk_..., or an access token, dko_...");
  }
  return workspaceId;
}

const needed = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new TypeError(`Pass ${name} to new Dinghy() first.`);
  return value;
};

/** A client for the Dinghy API, for a server. It runs on Node, Bun, Deno and Workers. */
export class Dinghy {
  readonly workspaceId: string;
  readonly conversations: ReturnType<typeof conversations>;
  readonly contacts: ReturnType<typeof contacts>;
  readonly outboundMessages: ReturnType<typeof outboundMessages>;
  readonly labels: ReturnType<typeof labels>;
  readonly savedReplies: ReturnType<typeof savedReplies>;
  readonly analytics: ReturnType<typeof analytics>;
  readonly workspace: ReturnType<typeof workspace>;
  /** The install, sites, widget, business hours and test visitors. They need a Full access key. */
  readonly setup: ReturnType<typeof setup>;
  /** The webhook routes need a Full access key. `verify` needs `webhookSecret`. */
  readonly webhooks: ReturnType<typeof webhookRoutes> & {
    verify: (received: Received) => Promise<WebhookEvent>;
  };
  readonly events: { stream: (options?: StreamOptions) => AsyncGenerator<StreamItem> };
  readonly identity: { sign: (user: HostUser) => Promise<string> };
  readonly #options: DinghyOptions;

  constructor(options: DinghyOptions) {
    this.#options = options;
    this.workspaceId = workspaceOf(options.apiKey);
    const request: Request = (method, path, ...args) => this.request(method, path, ...args);
    this.conversations = conversations(request);
    this.contacts = contacts(request);
    this.outboundMessages = outboundMessages(request);
    this.labels = labels(request);
    this.savedReplies = savedReplies(request);
    this.analytics = analytics(request);
    this.workspace = workspace(request);
    this.setup = setup(request);
    this.webhooks = {
      ...webhookRoutes(request),
      verify: async (received) =>
        verifyWebhook(received, needed(options.webhookSecret, "webhookSecret")),
    };
    this.events = { stream: (stream = {}) => streamEvents(this.#client(), stream) };
    this.identity = {
      sign: async (user) =>
        signHostToken(
          user,
          needed(options.signingSecret, "signingSecret"),
          needed(options.publicKey, "publicKey"),
        ),
    };
  }

  #client() {
    const { url, apiKey, fetch = globalThis.fetch } = this.#options;
    return { baseUrl: url, apiKey, workspaceId: this.workspaceId, fetch };
  }

  /** Any workspace route, typed from the API: `request("get", "/v1/operator/workspaces/{workspaceId}/labels")`. */
  request<P extends WorkspacePath, M extends MethodOf<P>>(
    method: M,
    path: P,
    ...[options]: RequestArgs<P, M>
  ): Promise<Answer<P, M>> {
    return call(this.#client(), method, path, options ?? {}) as Promise<Answer<P, M>>;
  }
}
