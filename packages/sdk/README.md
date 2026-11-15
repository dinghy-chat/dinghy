# Dinghy SDK

Call the [Dinghy](https://dinghy.chat) API from your server, a small live support chat you can host yourself. MIT licensed.

It has no dependencies. It uses `fetch` and WebCrypto, so it runs on Node 24, Bun, Deno and Cloudflare Workers. Its types come from Dinghy's OpenAPI file. It is for a server: never put an API key or a secret in a browser.

## Install

```sh
npm install @dinghy-chat/sdk
```

## Create a client

```ts
import { Dinghy } from "@dinghy-chat/sdk";

const dinghy = new Dinghy({
  url: "https://chat.example.com",
  apiKey: process.env.DINGHY_API_KEY,
  signingSecret: process.env.DINGHY_SIGNING_SECRET,
  publicKey: "YOUR_PUBLIC_KEY",
  webhookSecret: process.env.DINGHY_WEBHOOK_SECRET,
});
```

| Option          | What it is                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| `url`           | Your Dinghy server                                                                |
| `apiKey`        | A workspace API key, `dk_...`, from Settings > API keys, or an OAuth access token |
| `signingSecret` | The workspace's signing secret, for `identity.sign`                               |
| `publicKey`     | The workspace's public key, `wk_...`, for `identity.sign`                         |
| `webhookSecret` | The webhook's secret, for `webhooks.verify`                                       |
| `fetch`         | Optional. Replaces the global `fetch`, such as in a test                          |

The key names its workspace, so you never pass a workspace ID.

A method answers what the route answers, such as `{ outboundMessage }`. A refused request throws a `DinghyError` with the HTTP `status`, the API's `code` and a `message`. The client tries a request up to 3 times after a 429, a 503 or a dropped connection, and waits for `retry-after` when the server sends one. A send makes its own `clientId` when you pass none, and keeps it across these tries, so a retry never sends twice.

## Send a welcome that waits for the chat

Create a key with "Send directly" and "May send as a member" first. Then, in the signup handler:

```ts
await dinghy.outboundMessages.send({
  visitor: { userId: user.id, name: user.name, email: user.email },
  sender: { email: "julien@shipmail.to" },
  body: "Welcome to Shipmail! Stuck on DNS or an import? Ask me here.",
  dedupeKey: "welcome",
});
```

The message waits until the user opens the chat. `dedupeKey` sends it one time per user, however often the handler runs.

## Send a message later, and cancel it

```ts
await dinghy.outboundMessages.send({
  visitor: { userId: owner.id },
  body: `${domain.name} is not verified yet. Want me to check your DNS with you?`,
  delay: "1h",
  dedupeKey: `dns-unverified:${domain.id}`,
});

// When the domain verifies:
await dinghy.outboundMessages.cancel({
  visitor: { userId: owner.id },
  dedupeKey: `dns-unverified:${domain.id}`,
});
```

`cancel` also takes `{ id }`. `get(id)` and `list({ visitorId, status })` read sent messages.

## Sign users in to the chat

`identity.sign` makes the token for `Dinghy.identify` on your page. It needs `signingSecret` and `publicKey`.

```ts
const token = await dinghy.identity.sign({
  userId: user.id,
  name: user.name,
  email: user.email,
  attributes: { plan: user.plan },
});
```

The token is valid for one hour. Set `expiresInSeconds` for up to 24 hours. Give it only to the user's own session.

## Check a webhook

`webhooks.verify` checks the `Dinghy-Signature` header with `webhookSecret`, and returns the body, typed by its `type`. It throws a `DinghyError` with the code `bad_signature` when the signature does not match or is more than 5 minutes old.

```ts
export async function POST(request: Request) {
  const event = await dinghy.webhooks.verify(request);
  if (event.type === "outbound_message.replied") {
    console.log(event.data.outboundMessage.conversationId);
  }
  return new Response(null, { status: 204 });
}
```

It also takes `{ body, headers }`, with the raw body as a string or bytes. Read the body before any JSON parsing. A webhook may come more than once: use `Dinghy-Event-Id` to skip one you already handled.

## Read the events stream

`events.stream` reads the workspace's events with no public server, as a bot would. Each event has the same `type` and `data` as a webhook.

```ts
for await (const event of dinghy.events.stream({ types: ["message.created"] })) {
  if (event.type === "message.created") console.log(event.data.message.body);
}
```

It reconnects when the server ends the stream or the connection drops, and resumes after the last event. Pass `after` with an event's `id` to resume after a restart. A `resync` event means the position was too old: read the open conversations again.

## Everything else

| Group              | Methods                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations`    | `list`, `search`, `messages`, `reply`, `note`, `upload`, `receipt`, `close`, `reopen`, `snooze`, `assign`, `addLabel`, `removeLabel`, `handoff`, `typing`                                 |
| `contacts`         | `upsert`                                                                                                                                                                                  |
| `outboundMessages` | `send`, `get`, `list`, `cancel`                                                                                                                                                           |
| `labels`           | `list`                                                                                                                                                                                    |
| `savedReplies`     | `list`                                                                                                                                                                                    |
| `analytics`        | `get`                                                                                                                                                                                     |
| `workspace`        | `get`                                                                                                                                                                                     |
| `webhooks`         | `list`, `create`, `update`, `delete`, `rotateSecret`, `test`, `deliveries`, `replay`, `verify`                                                                                            |
| `setup`            | `snippet`, `checkInstall`, `identitySetup`, `sites`, `addSite`, `removeSite`, `widget`, `updateWidget`, `businessHours`, `updateBusinessHours`, `testVisitorMessage`, `clearTestVisitors` |

`webhooks` and `setup` need a key with Full access. `request` reaches any route a key may call, with the same types:

```ts
await dinghy.request("get", "/v1/operator/workspaces/{workspaceId}/labels");
```
