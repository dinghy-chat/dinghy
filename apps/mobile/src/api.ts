import { fetch } from "expo/fetch";
import { t } from "../../operator/src/text.ts";
import type {
  AlertSettings,
  Conversation,
  Me,
  Member,
  Message,
  PushProvider,
  Session,
  Thread,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

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

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

  async conversations(): Promise<{ conversations: Conversation[]; waiting: number }> {
    return this.call(this.workspace("/conversations?status=open&limit=100"));
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
    return { ...page, messages, hasMore: false };
  }

  reply(conversationId: string, clientId: string, body: string): Promise<Message> {
    return this.call(this.workspace(`/conversations/${conversationId}/messages`), {
      method: "POST",
      body: JSON.stringify({ clientId, body, note: false, mentions: [] }),
    });
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
