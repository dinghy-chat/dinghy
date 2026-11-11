import type { BillingStateName } from "../../../ee/operator/billing.tsx";
import type { SavedAppearance, WidgetSettings } from "../../../packages/widget/src/shared.ts";
import { readStream, retryAfterMs } from "../../../packages/widget/src/stream.ts";
import type { EventKind } from "../../server/src/db/schema.ts";

/** A list's assignee filter: the caller's conversations, or no one's. Null lists everyone's. */
export type Assignee = "me" | "none";

/** Who a visitor is, as the host site signed it. Every list that names a visitor holds this. */
export interface VisitorIdentity {
  id: string;
  email: string | null;
  externalId: string | null;
  /** The name the host site signed. */
  name: string | null;
}

interface Visitor extends VisitorIdentity {
  /** Custom attributes the host site signed. */
  attributes: Record<string, unknown> | null;
  blocked: boolean;
  /** Such as "Chrome on macOS". */
  device: string | null;
  /** The page the widget last reported, as origin and path. */
  lastPage: string | null;
  lastSeenAt: string | null;
}

/** A page in the visitor's journey, as the widget reported it. */
export interface PageView {
  /** Origin and path, never a query or hash. */
  path: string;
  title: string | null;
  viewedAt: string;
}

/** On Dinghy Cloud: what a welcome chat is linked to. */
export type WelcomeChat =
  | { with: "founder" }
  | {
      with: "workspace";
      name: string;
      access:
        | "active"
        | "waiting_cloud"
        | "read_only"
        | "suspended"
        | "waiting_payment"
        | "deleted";
    }
  | { with: "deleted" };

export type AnalyticsDays = 7 | 30 | 90;

/** Support numbers about the conversations that started in the period. */
export interface Analytics {
  days: number;
  timeZone: string;
  started: number;
  /** Of those, the ones closed now. */
  closed: number;
  answered: number;
  firstReply: {
    medianSeconds: number | null;
    p90Seconds: number | null;
    /** From 0 to 1, of the conversations started. */
    within5Minutes: number | null;
  };
  perDay: { date: string; conversations: number }[];
  /** By who sent the first reply. */
  operators: {
    /** One of the two is set: a member, or an API key that sent the first reply. */
    operatorId: string | null;
    apiKeyId: string | null;
    name: string | null;
    conversations: number;
  }[];
  /** Weekday (Monday first) by hour. */
  hours: number[][];
}

/** Values a page sent about the visitor, unsigned. */
type PageContext = Record<string, string | number | boolean | null>;

export interface Conversation {
  id: string;
  status: "open" | "closed";
  updatedAt: string;
  assigneeOperatorId: string | null;
  /** The page where the visitor started it, as origin and path. */
  startedPage: string | null;
  visitor: Visitor;
  /** What the host page sent with setContext(). Nobody signed it, so it is not verified. */
  pageContext: PageContext | null;
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: string } | null;
  /** A welcome chat on Dinghy Cloud. */
  welcome: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: string;
  kind: "text" | "image";
  fromVisitor: boolean;
  /** The operator who sent it, and their current name. Both null for a visitor's message. */
  authorOperatorId: string | null;
  /** The API key that sent it. Then `authorName` is the key's name. */
  authorApiKeyId: string | null;
  authorName: string | null;
  clientId: string;
  body: string | null;
  image: { url: string; width: number; height: number } | null;
  /** The image was deleted after 12 months, on Dinghy Cloud. */
  imageRemoved: boolean;
  createdAt: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  /** The same in every workspace. Null with none. */
  pictureUrl: string | null;
  workspaces: {
    workspaceId: string;
    role: Role;
    name: string;
    /** The workspace's logo, for the workspace menu. Null with none. */
    logoUrl: string | null;
    active: boolean;
    /** The subscription ended: operators can read and export, and cannot reply. */
    readOnly: boolean;
    /** An early cloud signup: everything works except the widget, until the cloud opens. */
    waiting: boolean;
    /** The server's admin suspended it: operators can read, and nobody can send. */
    suspended: boolean;
    /** This operator is its only owner, so they cannot delete their account yet. */
    soleOwner: boolean;
  }[];
  /** True on the cloud plan, where a workspace waits for payment. */
  billing: boolean;
  /** Who to write to about a suspension, on Dinghy Cloud. Null on a self-hosted server. */
  contact: string | null;
}

export type Role = "owner" | "admin" | "member";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  pictureUrl: string | null;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
}

export interface BlockedVisitor extends VisitorIdentity {
  blockedAt: string;
}

export interface Usage {
  operators: { used: number; limit: number };
  imageBytes: { used: number; limit: number };
}

export interface WorkspaceSettings {
  publicKey: string;
  allowedOrigins: string[];
  signingSecret: string;
  /** The plan's limits and their use, on Dinghy Cloud. Null with no limits. */
  usage: Usage | null;
  /** What a delete removes. A self-hosted server keeps its only workspace. */
  deletion: { conversations: number; images: number; members: number; onlyWorkspace: boolean };
}

/** A workspace API key. Its token is shown only when it is made. */
export interface ApiKey {
  id: string;
  /** Visitors and operators see this name on the key's replies. */
  name: string;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const WEBHOOK_EVENTS = [
  "conversation.created",
  "message.created",
  "conversation.closed",
  "conversation.reopened",
  "conversation.assigned",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  type: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  /** The HTTP status of the last attempt, or null when it got no answer. */
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A test send: delivered with the server's 2xx status, or refused with a status or an error. */
export type WebhookTest =
  | { delivered: true; status: number; error: null }
  | { delivered: false; status: number; error: string | null }
  | { delivered: false; status: null; error: string };

export interface AlertSettings {
  email: boolean;
  pushKey: string | null;
  emailAvailable: boolean;
}

export interface BillingState {
  state: BillingStateName;
  /** Renews, ends, becomes read-only or is deleted on this date, by state. */
  date: string | null;
  payWith: "checkout" | "portal";
}

export class ApiError extends Error {
  readonly status: number;
  /** The server's error code, such as operator_limit, when its answer had one. */
  readonly code: string | null;
  /** On a refused stream, how long to wait before the next try, from Retry-After. */
  readonly retryMs: number | undefined;
  constructor(status: number, code: string | null = null, retryMs?: number) {
    super(`The request failed with status ${status}`);
    this.status = status;
    this.code = code;
    this.retryMs = retryMs;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sent on `window` when the server refuses a write because the workspace is read-only or
 * suspended, so the app reads the workspace's state again.
 */
export const READ_ONLY_EVENT = "dinghy:read-only";

/** Throws for a failed response, and tells the app when the workspace turned out read-only. */
async function failed(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown };
  } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : null;
  if (code === "read_only" || code === "suspended") dispatchEvent(new Event(READ_ONLY_EVENT));
  throw new ApiError(response.status, code);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    // Loads run one at a time, so one that never answers would freeze the inbox.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
  });
  if (!response.ok) return failed(response);
  return (await response.json()) as T;
}

// Slower than the rest, because a phone's upload can take minutes.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Sends an image as the raw body. The server checks it, resizes it and stores it as WebP. */
async function putImage<T>(path: string, file: Blob): Promise<T> {
  const response = await fetch(path, {
    method: "PUT",
    cache: "no-store",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: { "content-type": file.type },
    body: file,
  });
  if (!response.ok) return failed(response);
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

/** The answer is the same for any email. Only an operator's email gets the link. */
export const askSignInLink = (email: string) =>
  post<{ ok: true }>("/v1/auth/sign-in/magic-link", { email });
/** Uses a sign-in link's token, from the button on the page the link opens. */
export const redeemSignInLink = (token: string) =>
  post<{ ok: true }>("/v1/auth/magic-link/verify", { token });
/** Uses a join link's token: joins the workspace and signs in. */
export const redeemJoinLink = (token: string) =>
  post<{ workspaceId: string }>("/v1/invites/open", { token });
export const signOut = () => post<unknown>("/v1/auth/sign-out", {});
export const updateName = (name: string) => post<unknown>("/v1/auth/update-user", { name });
export const getMe = () => call<Me>("/v1/operator/me");
type Picture = { pictureUrl: string | null };
export const setPicture = (file: Blob) => putImage<Picture>("/v1/operator/me/picture", file);
export const removePicture = () => call<Picture>("/v1/operator/me/picture", { method: "DELETE" });
/**
 * Deletes the account. With email, a link goes to it and `deleted` is false. Without, the typed
 * email confirms, and the account is gone.
 */
export const requestAccountDelete = (email?: string) =>
  post<{ deleted: boolean }>("/v1/operator/account/delete", email === undefined ? {} : { email });
/** Uses a delete link's token, from the button on the page the link opens. */
export const confirmAccountDelete = (token: string) =>
  post<{ ok: true }>("/v1/account/delete", { token });
export interface Meta {
  billing: boolean;
  /** How cloud signup works here, or null where nobody can sign up. */
  signup: "payment" | "early" | null;
  /** Whether sign-in links go by email. Without, the server's admin hands them out. */
  email: boolean;
}
export const getMeta = () => call<Meta>("/v1/meta");
/** The link in the email signs in, to a new account or the one the email has. */
export const signUp = (email: string) => post<{ ok: true }>("/v1/signup", { email });
/** Cloud signup's second step. It also sets the operator's name. */
export const createWorkspace = (name: string, workspaceName: string) =>
  post<{ workspaceId: string }>("/v1/operator/workspaces", { name, workspaceName });
export const startCheckout = (workspaceId: string) =>
  post<{ url: string }>(`/v1/operator/workspaces/${workspaceId}/checkout`, {});
export const saveDevice = (device: PushSubscriptionJSON) =>
  call<{ ok: true }>("/v1/operator/push-subscription", {
    method: "PUT",
    body: JSON.stringify(device),
  });
export const deleteDevice = (endpoint: string) =>
  call<{ ok: true }>("/v1/operator/push-subscription", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
export interface InviteOffer {
  workspaceName: string;
  /** Who made the invite. Empty when they have no name. */
  inviterName: string;
  role: "admin" | "member";
  /** Only this email can use the invite. */
  email: string;
  hasAccount: boolean;
  /** No account, or one left with no name: joining asks for a name. */
  needsName: boolean;
}
export const previewInvite = (token: string) => post<InviteOffer>("/v1/invites/preview", { token });
/**
 * Joins as the invite's email. A new account is made and signed in at once. For an existing one,
 * `workspaceId` is null: a link to join went to its email. Send `name` when the preview says `needsName`.
 */
export const joinWithInvite = (token: string, name?: string) =>
  post<{ workspaceId: string | null }>("/v1/invites/join", { token, name });
export const acceptInvite = (token: string) =>
  post<{ workspaceId: string }>("/v1/operator/invites/accept", { token });
export const testPush = () => post<{ sent: number; failed: number }>("/v1/operator/push-test", {});

export function workspaceApi(workspaceId: string) {
  const base = `/v1/operator/workspaces/${workspaceId}`;
  const conversation = (id: string) => `${base}/conversations/${id}`;
  return {
    rename: (name: string) =>
      call<{ name: string }>(base, { method: "PATCH", body: JSON.stringify({ name }) }),
    members: () => call<{ members: Member[] }>(`${base}/members`),
    setRole: (id: string, role: Role) =>
      call<{ ok: true }>(`${base}/members/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    removeMember: (id: string) => call<{ ok: true }>(`${base}/members/${id}`, { method: "DELETE" }),
    invites: () => call<{ invites: PendingInvite[] }>(`${base}/invites`),
    /** `token` is null when the server emailed the invite. */
    createInvite: (email: string, role: "admin" | "member") =>
      post<PendingInvite & { token: string | null }>(`${base}/invites`, { email, role }),
    revokeInvite: (id: string) => call<{ ok: true }>(`${base}/invites/${id}`, { method: "DELETE" }),
    settings: () => call<WorkspaceSettings>(`${base}/settings`),
    setOrigins: (allowedOrigins: string[]) =>
      call<WorkspaceSettings>(`${base}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ allowedOrigins }),
      }),
    rotateSecret: () => post<WorkspaceSettings>(`${base}/settings/rotate-secret`, {}),
    widget: () => call<SavedAppearance>(`${base}/widget`),
    setWidget: (settings: WidgetSettings) =>
      call<SavedAppearance>(`${base}/widget`, { method: "PUT", body: JSON.stringify(settings) }),
    setLogo: (file: Blob) => putImage<SavedAppearance>(`${base}/widget/logo`, file),
    removeLogo: () => call<SavedAppearance>(`${base}/widget/logo`, { method: "DELETE" }),
    exportUrl: `${base}/export`,
    apiKeys: () => call<{ apiKeys: ApiKey[] }>(`${base}/api-keys`),
    createApiKey: (name: string) => post<ApiKey & { token: string }>(`${base}/api-keys`, { name }),
    revokeApiKey: (id: string) =>
      call<{ ok: true }>(`${base}/api-keys/${id}`, { method: "DELETE" }),
    webhooks: () => call<{ webhooks: Webhook[] }>(`${base}/webhooks`),
    createWebhook: (url: string, events: WebhookEvent[]) =>
      post<Webhook & { secret: string }>(`${base}/webhooks`, { url, events }),
    changeWebhook: (id: string, change: Partial<Pick<Webhook, "url" | "events" | "enabled">>) =>
      call<Webhook>(`${base}/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
    deleteWebhook: (id: string) =>
      call<{ ok: true }>(`${base}/webhooks/${id}`, { method: "DELETE" }),
    rotateWebhookSecret: (id: string) =>
      post<Webhook & { secret: string }>(`${base}/webhooks/${id}/rotate-secret`, {}),
    testWebhook: (id: string) => post<WebhookTest>(`${base}/webhooks/${id}/test`, {}),
    webhookDeliveries: (id: string) =>
      call<{ deliveries: WebhookDelivery[] }>(`${base}/webhooks/${id}/deliveries`),
    billing: () => call<BillingState>(`${base}/billing`),
    analytics: (days: AnalyticsDays, timeZone: string) =>
      call<Analytics>(`${base}/analytics?days=${days}&tz=${encodeURIComponent(timeZone)}`),
    billingPortal: () => post<{ url: string }>(`${base}/billing-portal`, {}),
    /** The typed name must match the workspace's. */
    deleteWorkspace: (name: string) =>
      call<{ ok: true }>(base, { method: "DELETE", body: JSON.stringify({ name }) }),
    blockedVisitors: (offset: number) =>
      call<{
        hasMore: boolean;
        visitors: BlockedVisitor[];
      }>(`${base}/blocked-visitors?offset=${offset}`),
    unblockVisitor: (id: string) =>
      call<{ ok: true }>(`${base}/blocked-visitors/${id}`, { method: "DELETE" }),
    block: (id: string) => post<{ ok: true }>(`${conversation(id)}/block`, {}),
    unblock: (id: string) => call<{ ok: true }>(`${conversation(id)}/block`, { method: "DELETE" }),
    remove: (id: string) => call<{ ok: true }>(conversation(id), { method: "DELETE" }),
    assign: (id: string, operatorId: string | null) =>
      call<{ ok: true }>(`${conversation(id)}/assignee`, {
        method: "PUT",
        body: JSON.stringify({ operatorId }),
      }),
    beat: (viewing: string | null, left: string | null) =>
      call<{ viewers: Record<string, string[]> }>(`${base}/presence`, {
        method: "PUT",
        body: JSON.stringify({ viewing, left }),
      }),
    /** keepalive, so this still goes out while the page closes. */
    leave: (conversationId: string | null) =>
      call<{ ok: true }>(`${base}/presence/leave`, {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ conversationId }),
      }),
    alerts: () => call<AlertSettings>(`${base}/alerts`),
    setAlerts: (change: { email: boolean }) =>
      call<AlertSettings>(`${base}/alerts`, { method: "PATCH", body: JSON.stringify(change) }),
    /** Reads pages from the server's cursor until it has this many conversations. */
    async list(
      status: "open" | "closed",
      assignee: Assignee | null,
      limit: number,
      cancelled: () => boolean,
    ) {
      const conversations: Conversation[] = [];
      let waiting = 0;
      const whose = assignee === null ? "" : `&assignee=${assignee}`;
      for (;;) {
        const last = conversations.at(-1);
        const before =
          last === undefined
            ? ""
            : `&beforeUpdatedAt=${encodeURIComponent(last.updatedAt)}&beforeId=${last.id}`;
        const size = Math.min(limit - conversations.length, 100);
        const page = await call<{
          conversations: Conversation[];
          hasMore: boolean;
          waiting: number;
        }>(`${base}/conversations?status=${status}${whose}&limit=${size}${before}`);
        conversations.push(...page.conversations);
        // From the first page, so the count matches the rows on screen.
        if (last === undefined) waiting = page.waiting;
        if (!page.hasMore || conversations.length >= limit || cancelled()) {
          return { conversations, hasMore: page.hasMore, waiting };
        }
      }
    },
    messages: (id: string, after: string) =>
      call<{
        conversation: Conversation;
        messages: Message[];
        hasMore: boolean;
        /** A widget stream of the visitor's is open. Null when the server cannot tell. */
        visitorOnline: boolean | null;
        /** The visitor's newest pages, newest first, at most 20. */
        visitorPages: PageView[];
        /** A welcome chat on Dinghy Cloud, which has no visit or pages. Null otherwise. */
        welcome: WelcomeChat | null;
      }>(`${conversation(id)}/messages?after=${after}`),
    /** Open and closed conversations by visitor or message text. A newer search aborts this one. */
    search: (query: string, signal: AbortSignal) =>
      call<{ conversations: Conversation[] }>(
        `${base}/conversations/search?q=${encodeURIComponent(query)}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
      ),
    reply: (id: string, clientId: string, body: string) =>
      post<Message>(`${conversation(id)}/messages`, { clientId, body }),
    replyImage: async (id: string, clientId: string, file: File) => {
      const response = await fetch(`${conversation(id)}/images?clientId=${clientId}`, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        headers: { "content-type": file.type },
        body: file,
      });
      if (!response.ok) return failed(response);
      return (await response.json()) as Message;
    },
    setStatus: (id: string, status: "open" | "closed") =>
      call<{ ok: true }>(conversation(id), {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),

    /** Reads the stream until it ends, and resolves with the reason the server gave. */
    async stream(
      after: string | null,
      signal: AbortSignal,
      handlers: {
        /**
         * `conversationId` is null for a change to the workspace, such as its team. `fromVisitor`
         * is true for a visitor's new message.
         */
        change(
          cursor: string,
          kind: EventKind,
          conversationId: string | null,
          fromVisitor: boolean,
        ): void;
        ready(cursor: string | null): void;
        resync(cursor: string): void;
      },
    ): Promise<string | null> {
      const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
      const response = await fetch(`${base}/stream${query}`, { cache: "no-store", signal });
      // A 429 means the server holds too many streams, and the client must wait as long as it says.
      if (!response.ok) {
        throw new ApiError(
          response.status,
          null,
          response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined,
        );
      }
      return readStream<{
        kind: EventKind;
        conversationId?: string | null;
        fromVisitor?: boolean;
      }>(response, "change", {
        data: (value, cursor) =>
          handlers.change(
            cursor,
            value.kind,
            value.conversationId ?? null,
            value.fromVisitor === true,
          ),
        ready: handlers.ready,
        resync: handlers.resync,
      });
    },
  };
}

export type WorkspaceApi = ReturnType<typeof workspaceApi>;
