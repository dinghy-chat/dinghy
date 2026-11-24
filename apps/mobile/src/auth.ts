import { fetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { t } from "../../operator/src/text.ts";
import { ApiError, normalizeOrigin } from "./api";
import type { Session } from "./types";

const SESSION_KEY = "dinghy.native.session.v1";
const LEGACY_PROOF_KEY = "dinghy.native.sign-in-proof.v1";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CODE_LIFETIME_SECONDS = 10 * 60;
const DEFAULT_RESEND_SECONDS = 60;

type EmailCodeRequestResponse = {
  ok: true;
  expiresInSeconds?: number;
  resendAfterSeconds?: number;
};

type SignedInResponse = { status: "signed_in"; session: Session };
type EmailCodeVerifyResponse =
  | SignedInResponse
  | { status: "totp_required"; challenge: string; expiresInSeconds?: number };

export type EmailCodeRequest = {
  origin: string;
  email: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
};

export type EmailCodeResult =
  | { status: "signed_in"; session: Session }
  | { status: "totp_required"; challenge: string; expiresInSeconds: number };

function cloudOrigin(): string {
  // A loopback address set at build time replaces Dinghy Cloud, in development and in the
  // simulator build that takes the App Store screenshots. Store builds never set it.
  const configured = process.env.EXPO_PUBLIC_DINGHY_ORIGIN;
  if (!configured) return "https://app.dinghy.chat";
  const parsed = new URL(configured);
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "10.0.2.2";
  if (!loopback) throw new Error(t("mobileDevOriginLoopback"));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("mobileDevOriginProtocol"));
  }
  return parsed.origin;
}

export const CLOUD_ORIGIN = cloudOrigin();

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<Session>;
  return (
    typeof session.origin === "string" &&
    typeof session.session === "string" &&
    typeof session.operator?.id === "string" &&
    typeof session.workspace?.id === "string"
  );
}

export async function readSession(): Promise<Session | null> {
  await SecureStore.deleteItemAsync(LEGACY_PROOF_KEY);
  const saved = await SecureStore.getItemAsync(SESSION_KEY);
  if (saved === null) return null;
  try {
    const value: unknown = JSON.parse(saved);
    return isSession(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

async function post<T>(origin: string, path: string, body: object): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!response.ok) {
      if (response.status === 404) {
        throw new ApiError(
          response.status,
          "native_auth_unavailable",
          t("mobileNativeAuthUnavailable"),
        );
      }
      const code = typeof answer?.error?.code === "string" ? answer.error.code : null;
      const message =
        typeof answer?.error?.message === "string"
          ? answer.error.message
          : t("mobileServerStatus", { status: response.status });
      throw new ApiError(response.status, code, message);
    }
    return answer as T;
  } catch (failure) {
    if (controller.signal.aborted) throw new Error(t("mobileNativeAuthTimedOut"));
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function acceptSession(origin: string, value: unknown): Promise<Session> {
  if (!isSession(value)) throw new Error(t("mobileSignInInvalidSession"));
  if (value.origin !== origin) throw new Error(t("mobileSignInWrongOrigin"));
  await saveSession(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function requestEmailCode(server: string, email: string): Promise<EmailCodeRequest> {
  const origin = normalizeOrigin(server);
  const normalizedEmail = email.trim().toLowerCase();
  const answer = await post<EmailCodeRequestResponse>(
    origin,
    "/v1/auth/native/email-code/request",
    { email: normalizedEmail },
  );
  if (!isRecord(answer) || answer.ok !== true) {
    throw new Error(t("mobileSignInInvalidResponse"));
  }
  return {
    origin,
    email: normalizedEmail,
    expiresInSeconds: positiveSeconds(answer.expiresInSeconds, DEFAULT_CODE_LIFETIME_SECONDS),
    resendAfterSeconds: positiveSeconds(answer.resendAfterSeconds, DEFAULT_RESEND_SECONDS),
  };
}

export async function verifyEmailCode(
  request: EmailCodeRequest,
  code: string,
): Promise<EmailCodeResult> {
  const answer = await post<EmailCodeVerifyResponse>(
    request.origin,
    "/v1/auth/native/email-code/verify",
    { email: request.email, code },
  );
  if (!isRecord(answer)) throw new Error(t("mobileSignInInvalidResponse"));
  if (answer.status === "signed_in") {
    return { status: "signed_in", session: await acceptSession(request.origin, answer.session) };
  }
  if (answer.status !== "totp_required" || typeof answer.challenge !== "string") {
    throw new Error(t("mobileSignInInvalidResponse"));
  }
  return {
    status: "totp_required",
    challenge: answer.challenge,
    expiresInSeconds: positiveSeconds(answer.expiresInSeconds, DEFAULT_CODE_LIFETIME_SECONDS),
  };
}

export async function verifyTotp(
  origin: string,
  challenge: string,
  code: string,
): Promise<Session> {
  const answer = await post<SignedInResponse>(origin, "/v1/auth/native/totp/verify", {
    challenge,
    code,
  });
  if (!isRecord(answer) || answer.status !== "signed_in") {
    throw new Error(t("mobileSignInInvalidResponse"));
  }
  return await acceptSession(origin, answer.session);
}
