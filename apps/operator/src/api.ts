import { readStream, retryAfterMs } from "../../../packages/widget/src/stream.ts";
import type { EventKind } from "../../server/src/db/schema.ts";

export interface Visitor {
  id: string;
  email: string | null;
  externalId: string | null;
  claims: Record<string, unknown> | null;
  blocked: boolean;
}

export interface Conversation {
  id: string;
  status: "open" | "closed";
  updatedAt: string;
  assigneeOperatorId: string | null;
  /** The page where the visitor started it, as origin and path. */
  startedPage: string | null;
  visitor: Visitor;
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: string } | null;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: string;
  kind: "text" | "image";
  fromVisitor: boolean;
  /** The operator who sent it, and their current name. Both null for a visitor's message. */
  authorOperatorId: string | null;
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
  workspaces: {
    workspaceId: string;
    role: Role;
    name: string;
    active: boolean;
    /** The subscription ended: operators can read and export, and cannot reply. */
    readOnly: boolean;
    /** An early cloud signup: everything works except the widget, until the cloud opens. */
    waiting: boolean;
    /** The server's admin suspended it: operators can read, and nobody can send. */
    suspended: boolean;
  }[];
  /** True on the cloud plan, where a workspace waits for payment. */
  billing: boolean;
  /** Who to write to about a suspension, on Dinghy Cloud. Null on a self-hosted server. */
  contact: string | null;
}

export type Role = "owner" | "admin" | "agent";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface PendingInvite {
  id: string;
  role: "admin" | "agent";
  expiresAt: string;
}

export interface BlockedVisitor {
  id: string;
  email: string | null;
  externalId: string | null;
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
}

export interface AlertSettings {
  email: boolean;
  pushKey: string | null;
  emailAvailable: boolean;
}

export interface BillingState {
  state: "pending" | "active" | "ending" | "payment_failed" | "read_only";
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

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

/** The answer is the same for any email. Only an operator's email gets the link. */
export const askSignInLink = (email: string) =>
  post<{ ok: true }>("/v1/auth/sign-in/magic-link", { email });
export const signOut = () => post<unknown>("/v1/auth/sign-out", {});
export const updateName = (name: string) => post<unknown>("/v1/auth/update-user", { name });
export const getMe = () => call<Me>("/v1/operator/me");
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
export const previewInvite = (token: string) =>
  post<{ workspaceName: string; role: "admin" | "agent" }>("/v1/invites/preview", { token });
/** The link goes by email. With no mail server, `signInUrl` is the link, for a new account only. */
export const joinWithInvite = (token: string, name: string, email: string) =>
  post<{ ok: true; signInUrl: string | null }>("/v1/invites/join", { token, name, email });
export const acceptInvite = (token: string) =>
  post<{ workspaceId: string }>("/v1/operator/invites/accept", { token });
export const testPush = () => post<{ sent: number; failed: number }>("/v1/operator/push-test", {});

export function workspaceApi(workspaceId: string) {
  const base = `/v1/operator/workspaces/${workspaceId}`;
  const conversation = (id: string) => `${base}/conversations/${id}`;
  return {
    get: () => call<{ id: string; name: string }>(base),
    members: () => call<{ members: Member[] }>(`${base}/members`),
    setRole: (id: string, role: Role) =>
      call<{ ok: true }>(`${base}/members/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    removeMember: (id: string) => call<{ ok: true }>(`${base}/members/${id}`, { method: "DELETE" }),
    invites: () => call<{ invites: PendingInvite[] }>(`${base}/invites`),
    createInvite: (role: "admin" | "agent") =>
      post<PendingInvite & { token: string }>(`${base}/invites`, { role }),
    revokeInvite: (id: string) => call<{ ok: true }>(`${base}/invites/${id}`, { method: "DELETE" }),
    settings: () => call<WorkspaceSettings>(`${base}/settings`),
    setOrigins: (allowedOrigins: string[]) =>
      call<WorkspaceSettings>(`${base}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ allowedOrigins }),
      }),
    rotateSecret: () => post<WorkspaceSettings>(`${base}/settings/rotate-secret`, {}),
    exportUrl: `${base}/export`,
    billing: () => call<BillingState>(`${base}/billing`),
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
    async list(status: "open" | "closed", limit: number, cancelled: () => boolean) {
      const conversations: Conversation[] = [];
      let waiting = 0;
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
        }>(`${base}/conversations?status=${status}&limit=${size}${before}`);
        conversations.push(...page.conversations);
        // From the first page, so the count matches the rows on screen.
        if (last === undefined) waiting = page.waiting;
        if (!page.hasMore || conversations.length >= limit || cancelled()) {
          return { conversations, hasMore: page.hasMore, waiting };
        }
      }
    },
    messages: (id: string, after: string) =>
      call<{ conversation: Conversation; messages: Message[]; hasMore: boolean }>(
        `${conversation(id)}/messages?after=${after}`,
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
        /** `conversationId` is null for a change to the workspace, such as its team. */
        change(cursor: string, kind: EventKind, conversationId: string | null): void;
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
      return readStream<{ kind: EventKind; conversationId?: string | null }>(response, "change", {
        data: (value, cursor) => handlers.change(cursor, value.kind, value.conversationId ?? null),
        ready: handlers.ready,
        resync: handlers.resync,
      });
    },
  };
}

export type WorkspaceApi = ReturnType<typeof workspaceApi>;
