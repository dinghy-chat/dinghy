import type { BillingStateName } from "../../../ee/operator/billing.tsx";
import type { Quote } from "../../../packages/widget/src/quote.ts";
import type { SavedAppearance, WidgetSettings } from "../../../packages/widget/src/shared.ts";
import { readStream, retryAfterMs } from "../../../packages/widget/src/stream.ts";
import type { EventKind } from "../../server/src/db/schema.ts";
import type { OperatorNotice } from "../../server/src/live.ts";

export type { Quote };

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
  /** ISO 3166-1 alpha-2, from the widget's last beat. */
  country: string | null;
  /** IANA, such as Europe/Paris. */
  timeZone: string | null;
  /** Only Dinghy Cloud's welcome chat has one: its founder's. */
  pictureUrl: string | null;
  /** A test visitor that a bot's simulated message made. */
  isTest: boolean;
}

/** A page in the visitor's journey, as the widget reported it. */
export interface PageView {
  /** Origin and path, never a query or hash. */
  path: string;
  title: string | null;
  viewedAt: string;
}

/** Open conversations for each assignee filter. */
export interface OpenCounts {
  all: number;
  mine: number;
  unassigned: number;
}

/** On Dinghy Cloud: what a welcome chat is linked to. */
export type WelcomeChat =
  | { with: "founder"; pictureUrl: string | null }
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
    /** Of the conversations started, the ones with a first reply within 5 minutes. */
    fast: number;
  };
  /** The same numbers for a period of the same length just before. */
  previous: {
    started: number;
    firstReply: { medianSeconds: number | null; fast: number };
  };
  perDay: { date: string; conversations: number }[];
  /** By who sent the first reply, most first. */
  repliers: (
    | { kind: "operator"; operatorId: string; name: string; conversations: number }
    | { kind: "api_key"; apiKeyId: string; name: string; conversations: number }
    /** Deleted operators, all in one. */
    | { kind: "former"; conversations: number }
  )[];
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
  lastMessage: {
    /** The text, or a file's name. Null for an image, and for a file that was removed. */
    body: string | null;
    kind: ChatKind;
    fromVisitor: boolean;
    createdAt: string;
  } | null;
  /** A welcome chat on Dinghy Cloud. */
  welcome: boolean;
  /**
   * Who handles it: a bot that took part while no person handles it, the assigned person, or the
   * team when a person handles it unassigned. Null when no bot took part and no person handles it.
   */
  handler:
    | { kind: "bot"; apiKeyId: string; name: string }
    | { kind: "person"; operatorId: string; name: string; since: string }
    | { kind: "team"; since: string }
    | null;
  /** The bot that took part last, whoever handles it now. Null when no bot took part. */
  bot: { apiKeyId: string; name: string } | null;
  /** A visitor message is past this operator's read position. */
  unread: boolean;
  /** Snoozed: it waits for nobody until `until`, or with null until the visitor writes. */
  snooze: Snooze | null;
}

export interface Snooze {
  until: string | null;
}

/** A reply that an API key in draft mode wrote. No visitor has seen it. */
export interface SuggestedReply {
  id: string;
  conversationId: string;
  apiKeyId: string;
  /** The key's name. */
  authorName: string;
  body: string;
  /** `stale`: the visitor wrote after it. */
  status: "open" | "stale" | "sent" | "discarded";
  createdAt: string;
}

/** The kinds of message that visitors and the team write to each other. */
export type ChatKind = "text" | "image" | "file";

export interface Message {
  id: string;
  conversationId: string;
  seq: string;
  /**
   * `closed` and `reopened` are status lines that a close or a reopen wrote, with no body. A `note`
   * is text that only the team sees.
   */
  kind: ChatKind | "closed" | "reopened" | "note";
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
  /** A file that only downloads. `size` is in bytes. */
  file: { name: string; size: number; url: string } | null;
  /** The file was deleted after 12 months, on Dinghy Cloud. */
  fileRemoved: boolean;
  /** The message this one quotes. Its `id` is null when that message was deleted. */
  replyTo: Quote | null;
  /** When its author last changed its text. */
  editedAt: string | null;
  /** Deleted: no body and no image or file, and the line says so. */
  deleted: boolean;
  /** A key's reply: through the REST API or through MCP. `draft`: an operator sent a key's draft. */
  via: "api" | "mcp" | "draft" | null;
  /** A bot's handoff note: the member it handed the conversation to, or null for the team. */
  handoff: { operatorId: string | null } | null;
  /** The members a note mentions. Empty for any other message. */
  mentions: string[];
  createdAt: string;
}

/** Which first steps are done, for the signed-in member. */
export interface GetStarted {
  install: boolean;
  logo: boolean;
  widget: boolean;
  team: boolean;
  notifications: boolean;
  chat: boolean;
  dismissed: boolean;
}

/** One open tab of the site, from its last beat. */
export interface LiveVisitor {
  tab: string;
  /** Origin and path. */
  page: string;
  title: string | null;
  /** Where they came from, as an origin. */
  referrer: string | null;
  country: string | null;
  timeZone: string | null;
  device: string | null;
  startedAt: string;
  /** Only for a visitor who has used the chat. */
  visitor: (VisitorIdentity & { conversationId: string | null }) | null;
}

export type ContactSort = "lastSeen" | "firstSeen";

/** A person with at least one conversation. */
export interface Contact extends VisitorIdentity {
  /** The host site signed who this is, so the name and email are read-only. */
  signedIn: boolean;
  /** The signed `company` attribute. */
  company: string | null;
  country: string | null;
  timeZone: string | null;
  device: string | null;
  lastPage: string | null;
  lastSeenAt: string | null;
  /** First seen. */
  createdAt: string;
  conversationCount: number;
  blocked: boolean;
}

export interface ContactDetail extends Contact {
  /** A widget stream of the visitor's is open now. Null when the server cannot tell. */
  online: boolean | null;
  attributes: Record<string, unknown> | null;
  pageContext: PageContext | null;
  note: string | null;
  conversations: {
    id: string;
    status: "open" | "closed";
    createdAt: string;
    updatedAt: string;
    lastBody: string | null;
    /** Null with no message. */
    lastKind: ChatKind | null;
    messageCount: number;
    assigneeName: string | null;
    /** The member or key that closed it. Null while open, or when the visitor closed it. */
    closedBy: string | null;
    firstReplySeconds: number | null;
  }[];
  pages: PageView[];
}

/** How far the visitor has seen the replies: read up to a position, and the ranges emails carried. */
export interface ReplyReceipts {
  readSeq: string;
  emails: { fromSeq: string; toSeq: string; sent: boolean }[];
}

export interface Me {
  id: string;
  name: string;
  email: string;
  /** The same in every workspace. Null with none. */
  pictureUrl: string | null;
  /** Set Away, in every workspace: the widget does not count this operator online. */
  away: boolean;
  workspaces: {
    workspaceId: string;
    role: Role;
    name: string;
    /** The workspace's logo, for the workspace menu. Null with none. */
    logoUrl: string | null;
    /** An owner or admin paused every bot: API keys and connected apps may not reply or type. */
    botsPaused: boolean;
    /** Who paused the bots, or null when they run or that person is gone. */
    botsPausedBy: string | null;
    /** When the bots were paused, or null when they run. */
    botsPausedAt: string | null;
    active: boolean;
    /** The subscription ended: operators can read and export, and cannot reply. */
    readOnly: boolean;
    /** An early cloud signup: everything works except the widget, until the cloud opens. */
    waiting: boolean;
    /** The server's admin suspended it: operators can read, and nobody can send. */
    suspended: boolean;
    /** This operator is its only owner, so they cannot leave it. */
    soleOwner: boolean;
    /** For an only owner: who becomes the owner if they delete their account, or null when the
     * workspace goes with it. */
    heir: string | null;
  }[];
  /** True on the cloud plan, where a workspace waits for payment. */
  billing: boolean;
  /** Who to write to about a suspension, on Dinghy Cloud. Null on a self-hosted server. */
  contact: string | null;
  /** `required`: it is on, and this session must pass the check before anything else works. */
  twoFactor: "off" | "on" | "required";
}

export type Role = "owner" | "admin" | "member";

/** What the Appearance form saves: the widget's settings, and the operators the header shows. */
export interface AppearanceSettings extends WidgetSettings {
  /** Operator IDs, in order, for the `chosen` faces. Only members who are still on the team. */
  headerMembers: string[];
}

/** The saved appearance, as the operator app reads it. */
export type OperatorAppearance = SavedAppearance & AppearanceSettings;

export interface SavedReply {
  id: string;
  /** What follows `/` in the composer. */
  shortcut: string;
  /** Markdown, as a message's. */
  body: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  pictureUrl: string | null;
  /** Whether the member turned on two-step sign-in. */
  twoFactor: "off" | "on";
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
  /** Conversations, or Setup, which also reaches the webhooks. */
  level: ApiKeyLevel;
  /** `static`, a key made in Settings, or `oauth`, an app that an owner or admin connected. */
  source: "static" | "oauth";
  replyMode: ReplyMode;
  /** A connected app's origin. Null for a static key. */
  client: ClientOrigin | null;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const WEBHOOK_EVENTS = [
  "conversation.created",
  "message.created",
  "message.updated",
  "message.deleted",
  "conversation.closed",
  "conversation.reopened",
  "conversation.assigned",
  "conversation.handoff",
  "conversation.given_back",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type ApiKeyLevel = "conversations" | "setup";
/** `send`: replies go to the visitor. `draft`: they wait for a person to send them. */
export type ReplyMode = "send" | "draft";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  /** Who added it, or null for one from before this was kept. */
  createdBy: { kind: "operator" | "key"; name: string } | null;
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
  /** The start of the receiver's last refusing answer, up to 2 KB. */
  responseExcerpt: string | null;
  /** The delivery this one sends again, when it is a replay. */
  replayOf: string | null;
  replayedAt: string | null;
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
/** In each of the operator's workspaces, the open conversations that wait for a reply. */
export const getWaiting = () =>
  call<{ workspaces: { workspaceId: string; waiting: number }[] }>("/v1/operator/waiting");
type Picture = { pictureUrl: string | null };
export const setPicture = (file: Blob) => putImage<Picture>("/v1/operator/me/picture", file);
export const removePicture = () => call<Picture>("/v1/operator/me/picture", { method: "DELETE" });
export const setAway = (away: boolean) =>
  call<{ away: boolean }>("/v1/operator/me/status", {
    method: "PUT",
    body: JSON.stringify({ away }),
  });
/** Starts turning on two-step sign-in: a new secret, which works once a code confirms it. */
export const startTwoFactor = () =>
  post<{ secret: string; uri: string }>("/v1/operator/two-factor/setup", {});
/** Confirms the setup with a code, and returns the recovery codes, which show only now. */
export const enableTwoFactor = (code: string) =>
  post<{ recoveryCodes: string[] }>("/v1/operator/two-factor/enable", { code });
export const disableTwoFactor = (code: string) =>
  post<{ ok: true }>("/v1/operator/two-factor/disable", { code });
/** The second step of a sign-in, with a code from the app or a recovery code. */
export const checkTwoFactor = (code: string) =>
  post<{ ok: true }>("/v1/operator/two-factor/check", { code });
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
/** What the consent page shows for an OAuth request, or where to send the browser back. */
/**
 * Who an OAuth app is, as Dinghy can tell. `cimd`: the host that published its metadata document.
 * `dcr`: the host or scheme it returns to, which is on this computer when `local`.
 */
export interface ClientOrigin {
  kind: "dcr" | "cimd";
  host: string;
  local: boolean;
}

export type AuthorizeInfo =
  | {
      kind: "consent";
      client: ClientOrigin & { name: string };
      level: ApiKeyLevel;
      /** Where this operator is an owner or admin. */
      workspaces: { id: string; name: string }[];
    }
  | { kind: "redirect"; redirectTo: string };

/** `request` is the consent page's query string, as the app sent it. */
export const authorizeInfo = (request: string) =>
  call<AuthorizeInfo>(`/v1/operator/oauth/authorize-info${request}`);
export const approveApp = (
  workspaceId: string,
  choice: { request: string; level: ApiKeyLevel; replyMode: ReplyMode },
) => post<{ redirectTo: string }>(`/v1/operator/workspaces/${workspaceId}/oauth/grants`, choice);
export const denyApp = (request: string) =>
  post<{ redirectTo: string }>("/v1/operator/oauth/deny", { request });

export const testPush = () => post<{ sent: number; failed: number }>("/v1/operator/push-test", {});

export function workspaceApi(workspaceId: string) {
  const base = `/v1/operator/workspaces/${workspaceId}`;
  const conversation = (id: string) => `${base}/conversations/${id}`;
  return {
    workspaceId,
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
    widget: () => call<OperatorAppearance>(`${base}/widget`),
    setWidget: (settings: AppearanceSettings) =>
      call<OperatorAppearance>(`${base}/widget`, { method: "PUT", body: JSON.stringify(settings) }),
    setLogo: (file: Blob) => putImage<OperatorAppearance>(`${base}/widget/logo`, file),
    removeLogo: () => call<OperatorAppearance>(`${base}/widget/logo`, { method: "DELETE" }),
    setTypingPreview: (enabled: boolean) =>
      call<OperatorAppearance>(`${base}/widget/typing-preview`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    exportUrl: `${base}/export`,
    contactsExportUrl: `${base}/contacts/export`,
    getStarted: () => call<GetStarted>(`${base}/get-started`),
    dismissGetStarted: () => post<{ ok: true }>(`${base}/get-started/dismiss`, {}),
    liveVisitors: () => call<{ visitors: LiveVisitor[] | null }>(`${base}/visitors/live`),
    liveCount: () => call<{ count: number | null }>(`${base}/visitors/live/count`),
    contacts: (query: { q: string; sort: ContactSort; before: string | null }) => {
      const search = new URLSearchParams({ sort: query.sort });
      if (query.q.trim() !== "") search.set("q", query.q.trim());
      if (query.before !== null) search.set("before", query.before);
      return call<{ contacts: Contact[]; next: string | null }>(`${base}/contacts?${search}`);
    },
    contact: (visitorId: string) => call<ContactDetail>(`${base}/contacts/${visitorId}`),
    changeContact: (
      visitorId: string,
      change: { note?: string | null; name?: string | null; email?: string | null },
    ) =>
      call<ContactDetail>(`${base}/contacts/${visitorId}`, {
        method: "PATCH",
        body: JSON.stringify(change),
      }),
    deleteContact: (visitorId: string) =>
      call<{ ok: true }>(`${base}/contacts/${visitorId}`, { method: "DELETE" }),
    apiKeys: () => call<{ apiKeys: ApiKey[] }>(`${base}/api-keys`),
    createApiKey: (name: string, level: ApiKeyLevel, replyMode: ReplyMode) =>
      post<ApiKey & { token: string }>(`${base}/api-keys`, { name, level, replyMode }),
    setReplyMode: (id: string, replyMode: ReplyMode) =>
      call<ApiKey>(`${base}/api-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ replyMode }),
      }),
    setBotsPaused: (paused: boolean) =>
      call<{ paused: boolean; pausedBy: string | null }>(`${base}/bots-paused`, {
        method: "PUT",
        body: JSON.stringify({ paused }),
      }),
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
    replayDelivery: (id: string, deliveryId: string) =>
      post<{ delivery: WebhookDelivery }>(
        `${base}/webhooks/${id}/deliveries/${deliveryId}/replay`,
        {},
      ),
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
    /** A hidden tab views nothing, and still counts online. */
    beat: (viewing: string | null, left: string | null, hidden: boolean) =>
      call<{ viewers: Record<string, string[]> }>(`${base}/presence`, {
        method: "PUT",
        body: JSON.stringify({ viewing, left, hidden }),
      }),
    /** keepalive, so this still goes out while the page closes. A sign-out also ends the online mark. */
    leave: (conversationId: string | null, signingOut: boolean) =>
      call<{ ok: true }>(`${base}/presence/leave`, {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ conversationId, signingOut }),
      }),
    savedReplies: () => call<{ savedReplies: SavedReply[] }>(`${base}/saved-replies`),
    addSavedReply: (reply: { shortcut: string; body: string }) =>
      post<SavedReply>(`${base}/saved-replies`, reply),
    changeSavedReply: (id: string, change: { shortcut: string; body: string }) =>
      call<SavedReply>(`${base}/saved-replies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(change),
      }),
    deleteSavedReply: (id: string) =>
      call<{ ok: true }>(`${base}/saved-replies/${id}`, { method: "DELETE" }),
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
      let snoozeEndsInMs: number | null = null;
      let openBy: OpenCounts | null = null;
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
          snoozeEndsInMs: number | null;
          openBy: OpenCounts;
        }>(`${base}/conversations?status=${status}${whose}&limit=${size}${before}`);
        conversations.push(...page.conversations);
        // From the first page, so the count matches the rows on screen.
        if (last === undefined) {
          waiting = page.waiting;
          snoozeEndsInMs = page.snoozeEndsInMs;
          openBy = page.openBy;
        }
        if (!page.hasMore || conversations.length >= limit || cancelled()) {
          return { conversations, hasMore: page.hasMore, waiting, snoozeEndsInMs, openBy };
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
        receipts: ReplyReceipts;
      }>(`${conversation(id)}/messages?after=${after}`),
    /** Open and closed conversations by visitor or message text. A newer search aborts this one. */
    search: (query: string, signal: AbortSignal) =>
      call<{ conversations: Conversation[] }>(
        `${base}/conversations/search?q=${encodeURIComponent(query)}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
      ),
    /** A reply, or with `note` a note that only the team sees, which alerts the members it mentions. */
    reply: (
      id: string,
      clientId: string,
      body: string,
      replyToMessageId: string | undefined,
      note: boolean,
      mentions: string[],
    ) =>
      post<Message>(`${conversation(id)}/messages`, {
        clientId,
        body,
        replyToMessageId,
        note,
        mentions,
      }),
    replyUpload: async (id: string, clientId: string, file: File, replyToMessageId?: string) => {
      const quote = replyToMessageId === undefined ? "" : `&replyToMessageId=${replyToMessageId}`;
      const name = `&filename=${encodeURIComponent(file.name)}`;
      const response = await fetch(
        `${conversation(id)}/images?clientId=${clientId}${name}${quote}`,
        {
          method: "POST",
          cache: "no-store",
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          headers: { "content-type": file.type },
          body: file,
        },
      );
      if (!response.ok) return failed(response);
      return (await response.json()) as Message;
    },
    /** A note's mentions change with its text. A reply has none. */
    editMessage: (id: string, messageId: string, body: string, mentions: string[]) =>
      call<Message>(`${conversation(id)}/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ body, mentions }),
      }),
    deleteMessage: (id: string, messageId: string) =>
      call<{ ok: true }>(`${conversation(id)}/messages/${messageId}`, { method: "DELETE" }),
    /** When the visitor read a reply in the chat, and when an email first carried it. */
    messageReceipt: (id: string, messageId: string) =>
      call<{ readAt: string | null; emailedAt: string | null }>(
        `${conversation(id)}/messages/${messageId}/receipt`,
      ),
    /** Emails the visitor the whole conversation, through the worker. */
    sendTranscript: (id: string) =>
      call<{ ok: true }>(`${conversation(id)}/transcript`, { method: "POST" }),
    drafts: (id: string) => call<{ drafts: SuggestedReply[] }>(`${conversation(id)}/drafts`),
    /** Sends a draft as this operator's reply, with `body` in place of its text when edited. */
    sendDraft: (id: string, draftId: string, body?: string) =>
      post<Message>(`${conversation(id)}/drafts/${draftId}/send`, { body }),
    discardDraft: (id: string, draftId: string) =>
      post<{ ok: true }>(`${conversation(id)}/drafts/${draftId}/discard`, {}),
    /** Lets bots that send directly answer this conversation again. */
    giveBack: (id: string) => post<{ ok: true }>(`${conversation(id)}/give-back`, {}),
    /** Moves this operator's read position in the conversation forward to a message's seq. */
    markRead: (id: string, seq: string) => post<{ ok: true }>(`${conversation(id)}/read`, { seq }),
    setStatus: (id: string, status: "open" | "closed") =>
      call<{ ok: true }>(conversation(id), {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    /** Snoozes an open conversation, or ends its snooze with null. */
    setSnooze: (id: string, snooze: Snooze | null) =>
      call<{ ok: true }>(conversation(id), {
        method: "PATCH",
        body: JSON.stringify({ snooze }),
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
        /** A visitor's draft, or a sign to load a visitor's receipts again. It may be lost. */
        notice(notice: OperatorNotice): void;
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
        // This server's own stream, which sends only the notices it knows.
        notice: (value) => handlers.notice(value as OperatorNotice),
      });
    },
  };
}

export type WorkspaceApi = ReturnType<typeof workspaceApi>;
