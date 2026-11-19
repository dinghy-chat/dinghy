import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { apnsBody, createNativePush, fcmBody } from "./native-push.ts";
import type { PushPayload } from "./push.ts";

const payload: PushPayload = {
  title: "Acme",
  body: "A visitor wrote.",
  tag: "workspace:42",
  url: "/?workspace=workspace&conversation=conversation",
  workspaceId: "workspace",
  conversationId: "conversation",
};

describe("native push", () => {
  test("APNs and FCM payloads include explicit cold-start routing fields", () => {
    expect(JSON.parse(apnsBody(payload))).toEqual({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: "default",
        "thread-id": payload.tag,
      },
      body: {
        tag: payload.tag,
        url: payload.url,
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
      },
    });
    expect(JSON.parse(fcmBody("device", payload))).toEqual({
      message: {
        token: "device",
        notification: { title: payload.title, body: payload.body },
        data: {
          tag: payload.tag,
          url: payload.url,
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
        },
        android: {
          priority: "high",
          notification: { tag: payload.tag, channel_id: "conversations" },
        },
      },
    });
  });

  test("FCM waits for a send, shares authorization and removes unregistered tokens", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      return Response.json(
        { error: { details: [{ errorCode: "UNREGISTERED" }] } },
        { status: 400 },
      );
    }) as typeof fetch;
    const push = createNativePush(
      {
        fcm: {
          projectId: "project",
          clientEmail: "push@example.com",
          privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
      },
      request,
    );

    expect(calls).toEqual([]);
    await expect(
      Promise.all([
        push?.send({ provider: "fcm", token: "device-token-one" }, payload),
        push?.send({ provider: "fcm", token: "device-token-two" }, payload),
      ]),
    ).resolves.toEqual(["gone", "gone"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://fcm.googleapis.com/v1/projects/project/messages:send",
      "https://fcm.googleapis.com/v1/projects/project/messages:send",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(
      JSON.parse(fcmBody("device-token-one", payload)),
    );
  });

  test("an empty native configuration enables no provider", () => {
    expect(createNativePush({})).toBeUndefined();
  });
});
