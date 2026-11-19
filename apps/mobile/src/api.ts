import { fetch } from "expo/fetch";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";
import type {
  AlertSettings,
  Conversation,
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
    __DEV__ &&
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

  me(): Promise<Me> {
    return this.call("/v1/operator/me");
  }

  setAway(away: boolean): Promise<{ away: boolean }> {
    return this.call("/v1/operator/me/status", {
      method: "PUT",
      body: JSON.stringify({ away }),
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

  reply(conversationId: string, clientId: string, body: string): Promise<Message> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages`), {
      method: "POST",
      body: JSON.stringify({ clientId, body, note: false, mentions: [] }),
    });
  }

  async uploadPhoto(
    conversationId: string,
    clientId: string,
    photo: PhotoUpload,
  ): Promise<Message> {
    const local = await fetch(photo.uri);
    if (!local.ok) throw new Error(t("mobilePhotoReadFailed"));
    const body = await local.arrayBuffer();
    if (body.byteLength > MAX_IMAGE_BYTES) throw new Error(t("imageTooLarge"));
    return this.call(
      this.workspace(
        `/conversations/${conversationId}/uploads?clientId=${encodeURIComponent(clientId)}`,
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

  savedReplies(): Promise<{ savedReplies: SavedReply[] }> {
    return this.call(this.workspace("/saved-replies"));
  }

  contact(visitorId: string): Promise<components["schemas"]["ContactDetail"]> {
    return this.call(this.workspace(`/contacts/${encodeURIComponent(visitorId)}`));
  }

  markRead(conversationId: string, seq: string): Promise<{ ok: true }> {
    return this.call(this.workspace(`/conversations/${conversationId}/read`), {
      method: "POST",
      body: JSON.stringify({ seq }),
    });
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

  members(): Promise<{ members: Member[] }> {
    return this.call(this.workspace("/members"));
  }

  alerts(): Promise<AlertSettings> {
    return this.call(this.workspace("/alerts"));
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
