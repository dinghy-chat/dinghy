import { fetch } from "expo/fetch";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";
import type {
  AlertSettings,
  Conversation,
  Label,
  LabelColor,
  Me,
  Member,
  Message,
  PhotoUpload,
  PushProvider,
  SavedReply,
  Session,
  Thread,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
export const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

function normalizeOrigin(value: string): string {
  const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  const parsed = new URL(withScheme);
  const developmentLoopback =
    (__DEV__ || parsed.origin === process.env.EXPO_PUBLIC_DINGHY_ORIGIN) &&
    ["localhost", "127.0.0.1", "10.0.2.2"].includes(parsed.hostname) &&
    parsed.protocol === "http:";
  if (parsed.protocol !== "https:" && !developmentLoopback) {
    throw new Error(t("mobileUseHttpsAddress"));
  }
  return parsed.origin;
}

export { normalizeOrigin };

export class DinghyApi {
  constructor(private readonly auth: Session) {}

  private async call<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.auth.origin}${path}`, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Cookie: this.auth.session,
          Origin: this.auth.origin,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        const answer = (await response.json().catch(() => null)) as {
          error?: { code?: unknown; message?: unknown };
        } | null;
        const code = typeof answer?.error?.code === "string" ? answer.error.code : null;
        const detail =
          typeof answer?.error?.message === "string"
            ? answer.error.message
            : t("mobileServerStatus", { status: response.status });
        throw new ApiError(response.status, code, detail);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private workspace(path: string): string {
    return `/v1/operator/workspaces/${this.auth.workspace.id}${path}`;
  }

  private pictureUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const url = new URL(value, this.auth.origin);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  async me(): Promise<Me> {
    const account = await this.call<Me>("/v1/operator/me");
    return {
      ...account,
      pictureUrl: this.pictureUrl(account.pictureUrl),
      workspaces: account.workspaces.map((workspace) => ({
        ...workspace,
        logoUrl: this.pictureUrl(workspace.logoUrl),
      })),
    };
  }

  updateName(name: string): Promise<unknown> {
    return this.call("/v1/auth/update-user", { method: "POST", body: JSON.stringify({ name }) });
  }

  async updatePicture(photo: PhotoUpload): Promise<{ pictureUrl: string | null }> {
    const local = await fetch(photo.uri);
    if (!local.ok) throw new Error(t("mobilePhotoReadFailed"));
    const body = await local.arrayBuffer();
    if (body.byteLength > MAX_PROFILE_IMAGE_BYTES) throw new Error(t("pictureTooLarge"));
    const result = await this.call<{ pictureUrl: string }>(
      "/v1/operator/me/picture",
      { method: "PUT", headers: { "Content-Type": photo.mimeType }, body },
      UPLOAD_TIMEOUT_MS,
    );
    return { pictureUrl: new URL(result.pictureUrl, this.auth.origin).href };
  }

  removePicture(): Promise<{ pictureUrl: null }> {
    return this.call("/v1/operator/me/picture", { method: "DELETE" });
  }

  setAway(away: boolean): Promise<{ away: boolean }> {
    return this.call("/v1/operator/me/status", {
      method: "PUT",
      body: JSON.stringify({ away }),
    });
  }

  /**
   * Deletes the account at once, or emails a link that does it. The operator types `email` to
   * confirm. With no mail server, the server deletes only when it is the account's.
   */
  deleteAccount(email: string): Promise<{ deleted: boolean }> {
    return this.call("/v1/operator/account/delete", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  signOut(): Promise<unknown> {
    return this.call("/v1/auth/sign-out", { method: "POST", body: "{}" });
  }

  private withVisitorPicture(conversation: Conversation): Conversation {
    const visitor = conversation.visitor;
    const path = visitor.attributes?.avatarPath;
    // Signed visitor attributes can point to a public portrait on this instance.
    const portrait =
      visitor.pictureUrl ??
      (typeof path === "string" && /^\/v1\/pictures\/[a-zA-Z0-9-]+$/.test(path) ? path : null);
    if (!portrait) return conversation;
    try {
      const pictureUrl = new URL(portrait, this.auth.origin).href;
      return { ...conversation, visitor: { ...visitor, pictureUrl } };
    } catch {
      return conversation;
    }
  }

  liveVisitorCount(): Promise<{ count: number | null }> {
    return this.call(this.workspace("/visitors/live/count"));
  }

  async conversations(): Promise<{ conversations: Conversation[]; waiting: number }> {
    const page = await this.call<{ conversations: Conversation[]; waiting: number }>(
      this.workspace("/conversations?status=open&limit=100"),
    );
    return {
      ...page,
      conversations: page.conversations.map((item) => this.withVisitorPicture(item)),
    };
  }

  async thread(conversationId: string): Promise<Thread> {
    let after = "0";
    const messages: Message[] = [];
    let page: Thread;
    do {
      page = await this.call(
        this.workspace(
          `/conversations/${conversationId}/messages?after=${encodeURIComponent(after)}`,
        ),
      );
      messages.push(...page.messages);
      const last = page.messages.at(-1);
      if (!last) break;
      after = last.seq;
    } while (page.hasMore);
    const firstText = messages.find((message) => !message.deleted && message.kind === "text");
    const subject =
      page.conversation.subject ?? firstText?.body?.split("\n", 1)[0]?.trim().slice(0, 120) ?? null;
    return {
      ...page,
      conversation: this.withVisitorPicture({ ...page.conversation, subject }),
      messages,
      hasMore: false,
    };
  }

  reply(
    conversationId: string,
    clientId: string,
    body: string,
    replyToMessageId?: string,
  ): Promise<Message> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages`), {
      method: "POST",
      body: JSON.stringify({ clientId, body, replyToMessageId, note: false, mentions: [] }),
    });
  }

  async uploadPhoto(
    conversationId: string,
    clientId: string,
    photo: PhotoUpload,
    replyToMessageId?: string,
  ): Promise<Message> {
    const local = await fetch(photo.uri);
    if (!local.ok) throw new Error(t("mobilePhotoReadFailed"));
    const body = await local.arrayBuffer();
    if (body.byteLength > MAX_IMAGE_BYTES) throw new Error(t("imageTooLarge"));
    return this.call(
      this.workspace(
        `/conversations/${conversationId}/uploads?${new URLSearchParams({
          clientId,
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        })}`,
      ),
      { method: "POST", headers: { "Content-Type": photo.mimeType }, body },
      UPLOAD_TIMEOUT_MS,
    );
  }

  note(conversationId: string, clientId: string, body: string): Promise<Message> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages`), {
      method: "POST",
      body: JSON.stringify({ clientId, body, note: true, mentions: [] }),
    });
  }

  editMessage(
    conversationId: string,
    messageId: string,
    body: string,
    mentions: string[] = [],
  ): Promise<Message> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages/${messageId}`), {
      method: "PATCH",
      body: JSON.stringify({ body, mentions }),
    });
  }

  deleteMessage(conversationId: string, messageId: string): Promise<{ ok: true }> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages/${messageId}`), {
      method: "DELETE",
    });
  }

  messageReceipt(
    conversationId: string,
    messageId: string,
  ): Promise<{ readAt: string | null; emailedAt: string | null }> {
    return this.call(
      this.workspace(`/conversations/${conversationId}/messages/${messageId}/receipt`),
    );
  }

  conversationLink(conversationId: string): string {
    const url = new URL("/", this.auth.origin);
    url.searchParams.set("workspace", this.auth.workspace.id);
    url.searchParams.set("conversation", conversationId);
    return url.href;
  }

  messageLink(conversationId: string, messageId: string): string {
    const url = new URL(this.conversationLink(conversationId));
    url.hash = `message-${messageId}`;
    return url.href;
  }

  savedReplies(): Promise<{ savedReplies: SavedReply[] }> {
    return this.call(this.workspace("/saved-replies"));
  }

  addSavedReply(reply: { shortcut: string; body: string }): Promise<SavedReply> {
    return this.call(this.workspace("/saved-replies"), {
      method: "POST",
      body: JSON.stringify(reply),
    });
  }

  changeSavedReply(id: string, change: { shortcut: string; body: string }): Promise<SavedReply> {
    return this.call(this.workspace(`/saved-replies/${id}`), {
      method: "PATCH",
      body: JSON.stringify(change),
    });
  }

  deleteSavedReply(id: string): Promise<{ ok: true }> {
    return this.call(this.workspace(`/saved-replies/${id}`), { method: "DELETE" });
  }

  changeContact(
    visitorId: string,
    change: { note?: string | null; name?: string | null; email?: string | null },
  ): Promise<components["schemas"]["ContactDetail"]> {
    return this.call(this.workspace(`/contacts/${encodeURIComponent(visitorId)}`), {
      method: "PATCH",
      body: JSON.stringify(change),
    });
  }

  /** Blocks or unblocks a visitor. A block goes through one of their conversations. */
  setBlocked(conversationId: string, blocked: boolean): Promise<{ ok: true }> {
    return this.call(
      this.workspace(`/conversations/${encodeURIComponent(conversationId)}/block`),
      blocked ? { method: "POST", body: "{}" } : { method: "DELETE" },
    );
  }

  contact(visitorId: string): Promise<components["schemas"]["ContactDetail"]> {
    return this.call(this.workspace(`/contacts/${encodeURIComponent(visitorId)}`));
  }

  contacts(query: {
    q: string;
    sort: "lastSeen" | "firstSeen";
    before: string | null;
    hasChatted: boolean;
  }): Promise<{ contacts: components["schemas"]["Contact"][]; next: string | null }> {
    const search = new URLSearchParams({ sort: query.sort, hasChatted: String(query.hasChatted) });
    if (query.q.trim()) search.set("q", query.q.trim());
    if (query.before !== null) search.set("before", query.before);
    return this.call(this.workspace(`/contacts?${search}`));
  }

  liveVisitors(): Promise<{ visitors: components["schemas"]["LiveVisitor"][] | null }> {
    return this.call(this.workspace("/visitors/live"));
  }

  markRead(conversationId: string, seq: string): Promise<{ ok: true }> {
    return this.call(this.workspace(`/conversations/${conversationId}/read`), {
      method: "POST",
      body: JSON.stringify({ seq }),
    });
  }

  analytics(days: 7 | 30 | 90, timeZone: string): Promise<components["schemas"]["Analytics"]> {
    const query = new URLSearchParams({ days: String(days), tz: timeZone });
    return this.call(this.workspace(`/analytics?${query}`));
  }

  setStatus(conversationId: string, status: "open" | "closed"): Promise<{ ok: true }> {
    return this.call(this.workspace(`/conversations/${conversationId}`), {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  assign(conversationId: string, operatorId: string | null): Promise<{ ok: true }> {
    return this.call(this.workspace(`/conversations/${conversationId}/assignee`), {
      method: "PUT",
      body: JSON.stringify({ operatorId }),
    });
  }

  async members(): Promise<{ members: Member[] }> {
    const team = await this.call<{ members: Member[] }>(this.workspace("/members"));
    return {
      members: team.members.map((member) => ({
        ...member,
        pictureUrl: this.pictureUrl(member.pictureUrl),
      })),
    };
  }

  renameWorkspace(name: string): Promise<{ name: string }> {
    return this.call(this.workspace(""), {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  alerts(): Promise<AlertSettings> {
    return this.call(this.workspace("/alerts"));
  }

  setAlerts(email: boolean): Promise<AlertSettings> {
    return this.call(this.workspace("/alerts"), {
      method: "PATCH",
      body: JSON.stringify({ email }),
    });
  }

  labels(): Promise<{ labels: Label[] }> {
    return this.call(this.workspace("/labels"));
  }

  addLabel(input: { name: string; color: LabelColor }): Promise<Label> {
    return this.call(this.workspace("/labels"), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  changeLabel(id: string, input: { name: string; color: LabelColor }): Promise<Label> {
    return this.call(this.workspace(`/labels/${id}`), {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  deleteLabel(id: string): Promise<{ ok: true }> {
    return this.call(this.workspace(`/labels/${id}`), { method: "DELETE" });
  }

  installSnippet(): Promise<components["schemas"]["InstallSnippet"]> {
    return this.call(this.workspace("/install/snippet?framework=html"));
  }

  registerPush(provider: PushProvider, token: string): Promise<{ ok: true }> {
    return this.call("/v1/operator/push-device", {
      method: "PUT",
      body: JSON.stringify({ provider, token }),
    });
  }

  unregisterPush(provider: PushProvider, token: string): Promise<{ ok: true }> {
    return this.call("/v1/operator/push-device", {
      method: "DELETE",
      body: JSON.stringify({ provider, token }),
    });
  }
}
