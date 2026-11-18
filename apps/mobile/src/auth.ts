import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Linking } from "react-native";
import { t } from "../../operator/src/text.ts";
import { normalizeOrigin } from "./api";
import type { Session } from "./types";

const SESSION_KEY = "dinghy.native.session.v1";
const PROOF_KEY = "dinghy.native.sign-in-proof.v1";
const REDIRECT_URI = "dinghy://auth/callback";
const PROOF_MAX_AGE_MS = 15 * 60_000;

type PendingProof = {
  origin: string;
  state: string;
  codeVerifier: string;
  createdAt: number;
};

function cloudOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_DINGHY_ORIGIN;
  if (!__DEV__ || !configured) return "https://app.dinghy.chat";
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

function base64Url(value: string): string {
  return value.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function randomText(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64Url(globalThis.btoa(binary));
}

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
  await readPendingProof();
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

function isPendingProof(value: unknown): value is PendingProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Partial<PendingProof>;
  return (
    typeof proof.origin === "string" &&
    typeof proof.state === "string" &&
    typeof proof.codeVerifier === "string" &&
    typeof proof.createdAt === "number"
  );
}

async function readPendingProof(): Promise<PendingProof | null> {
  const saved = await SecureStore.getItemAsync(PROOF_KEY);
  if (saved === null) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (!isPendingProof(value) || Date.now() - value.createdAt > PROOF_MAX_AGE_MS) {
      await SecureStore.deleteItemAsync(PROOF_KEY);
      return null;
    }
    return value;
  } catch {
    await SecureStore.deleteItemAsync(PROOF_KEY);
    return null;
  }
}

export async function hasPendingSignIn(): Promise<boolean> {
  return (await readPendingProof()) !== null;
}

export async function cancelPendingSignIn(): Promise<void> {
  await SecureStore.deleteItemAsync(PROOF_KEY);
}

export async function beginSignIn(server: string): Promise<void> {
  const origin = normalizeOrigin(server);
  const state = await randomText();
  const codeVerifier = await randomText();
  const codeChallenge = base64Url(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
  );
  const query = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    state,
  });
  await SecureStore.setItemAsync(
    PROOF_KEY,
    JSON.stringify({ origin, state, codeVerifier, createdAt: Date.now() } satisfies PendingProof),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  try {
    await Linking.openURL(`${origin}/operator/native-sign-in?${query.toString()}`);
  } catch (failure) {
    await cancelPendingSignIn();
    throw failure;
  }
}

export async function completeSignIn(url: string): Promise<Session | null> {
  const callback = new URL(url);
  if (
    callback.protocol !== "dinghy:" ||
    callback.host !== "auth" ||
    callback.pathname !== "/callback"
  ) {
    return null;
  }
  const proof = await readPendingProof();
  if (proof === null) throw new Error(t("mobileSignInExpired"));
  if (callback.searchParams.get("state") !== proof.state) {
    throw new Error(t("mobileSignInMismatch"));
  }
  const callbackError = callback.searchParams.get("error");
  if (callbackError) {
    await cancelPendingSignIn();
    throw new Error(t("mobileSignInCancelled"));
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(t("mobileSignInNoCode"));

  const response = await fetch(`${proof.origin}/v1/auth/native/exchange`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: proof.origin,
    },
    body: JSON.stringify({ code, codeVerifier: proof.codeVerifier }),
  });
  if (!response.ok) {
    const answer = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    const detail =
      typeof answer?.error?.message === "string"
        ? answer.error.message
        : t("mobileSignInServerFailed");
    await cancelPendingSignIn();
    throw new Error(detail);
  }
  const session: unknown = await response.json();
  if (!isSession(session)) {
    await cancelPendingSignIn();
    throw new Error(t("mobileSignInInvalidSession"));
  }
  if (session.origin !== proof.origin) {
    await cancelPendingSignIn();
    throw new Error(t("mobileSignInWrongOrigin"));
  }
  await cancelPendingSignIn();
  await saveSession(session);
  return session;
}
