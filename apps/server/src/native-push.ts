import { connect, constants, type IncomingHttpHeaders } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type { NativePushProvider } from "./db/schema.ts";
import type { PushPayload, PushResult } from "./push.ts";

interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  environment: "production" | "sandbox";
}

interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface NativePushConfig {
  apns?: ApnsConfig;
  fcm?: FcmConfig;
}

interface NativePushTarget {
  provider: NativePushProvider;
  token: string;
}

export interface NativePush {
  providers: readonly NativePushProvider[];
  send(target: NativePushTarget, payload: PushPayload, signal?: AbortSignal): Promise<PushResult>;
}

const SEND_TIMEOUT_MS = 15_000;
const TTL_SECONDS = 86_400;
const APNS_TOKEN_MS = 50 * 60_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";

const privateKey = (value: string) => value.replaceAll("\\n", "\n");

const routeData = (payload: PushPayload) => ({
  tag: payload.tag,
  url: payload.url,
  ...(payload.workspaceId === undefined ? {} : { workspaceId: payload.workspaceId }),
  ...(payload.conversationId === undefined ? {} : { conversationId: payload.conversationId }),
});

export function apnsBody(payload: PushPayload): string {
  return JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      "thread-id": payload.tag,
    },
    // Expo maps this APNs field to notification.request.content.data on iOS.
    body: routeData(payload),
  });
}

export function fcmBody(token: string, payload: PushPayload): string {
  return JSON.stringify({
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: routeData(payload),
      android: {
        priority: "high",
        notification: { tag: payload.tag, channel_id: "conversations" },
      },
    },
  });
}

function createApnsSender(config: ApnsConfig) {
  const origin =
    config.environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  let authorization: { value: string; madeAt: number } | undefined;
  let authorizationWork: Promise<string> | undefined;

  const makeToken = async () => {
    const madeAt = Date.now();
    const key = await importPKCS8(privateKey(config.privateKey), "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setIssuedAt(Math.floor(madeAt / 1000))
      .sign(key);
    authorization = { value, madeAt };
    return value;
  };
  const token = () => {
    if (authorization !== undefined && Date.now() - authorization.madeAt < APNS_TOKEN_MS) {
      return authorization.value;
    }
    authorizationWork ??= makeToken().finally(() => {
      authorizationWork = undefined;
    });
    return authorizationWork;
  };

  return async (
    target: NativePushTarget,
    payload: PushPayload,
    stopping?: AbortSignal,
  ): Promise<PushResult> => {
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const signal = stopping === undefined ? timeout : AbortSignal.any([stopping, timeout]);
    try {
      const bearer = await token();
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const session = connect(origin);
        let settled = false;
        const finish = (result: { status: number; body: string } | Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          session.close();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const abort = () => {
          request.close(constants.NGHTTP2_CANCEL);
          finish(signal.reason instanceof Error ? signal.reason : new Error("push aborted"));
        };
        const request = session.request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(target.token)}`,
          authorization: `bearer ${bearer}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + TTL_SECONDS),
          "apns-collapse-id": payload.tag.slice(0, 64),
          "content-type": "application/json",
        });
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers: IncomingHttpHeaders) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => finish({ status, body }));
        request.on("error", (error) => finish(error));
        session.on("error", (error) => finish(error));
        if (signal.aborted) abort();
        else {
          signal.addEventListener("abort", abort, { once: true });
          request.end(apnsBody(payload));
        }
      });
      if (response.status === 200) return "sent";
      if (
        response.status === 410 ||
        (response.status === 400 &&
          /BadDeviceToken|DeviceTokenNotForTopic|Unregistered/.test(response.body))
      ) {
        return "gone";
      }
      return "failed";
    } catch (error) {
      if (stopping?.aborted) throw error;
      return "failed";
    }
  };
}

function createFcmSender(config: FcmConfig, request: typeof fetch) {
  let authorization: { value: string; expiresAt: number } | undefined;
  let authorizationWork: Promise<string> | undefined;

  const makeToken = async (signal?: AbortSignal) => {
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(privateKey(config.privateKey), "RS256");
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.clientEmail)
      .setAudience(FCM_TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const response = await request(FCM_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json();
    if (
      !response.ok ||
      typeof body !== "object" ||
      body === null ||
      !("access_token" in body) ||
      typeof body.access_token !== "string"
    ) {
      throw new Error(`FCM authorization failed with ${response.status}`);
    }
    const expiresIn =
      "expires_in" in body && typeof body.expires_in === "number" ? body.expires_in : 3600;
    authorization = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, expiresIn) * 1000,
    };
    return authorization.value;
  };
  const token = (signal?: AbortSignal) => {
    if (authorization !== undefined && authorization.expiresAt - Date.now() > 60_000) {
      return authorization.value;
    }
    authorizationWork ??= makeToken(signal).finally(() => {
      authorizationWork = undefined;
    });
    return authorizationWork;
  };

  return async (
    target: NativePushTarget,
    payload: PushPayload,
    stopping?: AbortSignal,
  ): Promise<PushResult> => {
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const signal = stopping === undefined ? timeout : AbortSignal.any([stopping, timeout]);
    try {
      const bearer = await token(signal);
      const response = await request(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: fcmBody(target.token, payload),
          signal,
        },
      );
      const body = await response.text();
      if (response.ok) return "sent";
      if (response.status === 404 || response.status === 410 || body.includes("UNREGISTERED")) {
        return "gone";
      }
      return "failed";
    } catch (error) {
      if (stopping?.aborted) throw error;
      return "failed";
    }
  };
}

export function createNativePush(
  config: NativePushConfig,
  request: typeof fetch = fetch,
): NativePush | undefined {
  const apns = config.apns === undefined ? undefined : createApnsSender(config.apns);
  const fcm = config.fcm === undefined ? undefined : createFcmSender(config.fcm, request);
  const providers: NativePushProvider[] = [
    ...(apns === undefined ? [] : (["apns"] as const)),
    ...(fcm === undefined ? [] : (["fcm"] as const)),
  ];
  if (providers.length === 0) return undefined;
  return {
    providers,
    send(target, payload, signal) {
      const sender = target.provider === "apns" ? apns : fcm;
      return sender === undefined ? Promise.resolve("failed") : sender(target, payload, signal);
    },
  };
}
