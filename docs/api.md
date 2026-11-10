# API

Dinghy's widget and operator app use the same HTTP API that you can build on, for example a custom widget, a bot or an integration. Every install serves its full description as OpenAPI 3.1 at `/v1/openapi.json`, such as `https://chat.example.com/v1/openapi.json`. The same file is in the repository at [`apps/server/openapi.json`](../apps/server/openapi.json).

## Versions

Every route starts with `/v1`. Within `v1`, a release may add routes, fields and error codes. A change that would break a client is meant for a new version, and the [changelog](../CHANGELOG.md) names every API change.

## Two APIs and the ways to sign in

- **The widget API**, at `/v1/widget/{key}`, where `key` is the workspace's public key. It answers only pages whose `Origin` is on the workspace's allowed sites. `POST /v1/widget/{key}/visitors` creates a visitor and returns its browser token once. Other calls send it as `Authorization: Bearer <token>`. For a signed-in user, the bearer token is a host token that your site's server signs instead, as [Add the chat to your website](add-to-your-site.md#show-who-is-chatting) explains.
- **A reply email's chat page**, at `/chat/{token}` on the Dinghy server itself. Its page uses the widget API with the link's token, which starts with `dcl_`, as `Authorization: Bearer dcl_...`. The widget API takes that token only from the Dinghy server's own origin, or with no `Origin` header, and takes no other token from there. It works for 30 days.
- **The operator API**, at `/v1/operator`. It uses the session cookie that sign-in sets. Sign-in and sign-out live at `/v1/auth`: `POST /v1/auth/sign-in/magic-link` with `{ "email" }` emails a link, `POST /v1/auth/magic-link/verify` with `{ "token" }` uses one, which the button on the page the link opens does, and `POST /v1/auth/sign-out` ends the session. They pass through to the BetterAuth library, so their shape follows it and is not part of the versioned API. A request that changes something must also send the server's own `Origin`, so with a session the operator API works only from the operator app's pages.
- **An API key**, for your own scripts and AI agents. It works on part of the operator API, with no session and no `Origin`, as `Authorization: Bearer dk_...`. See [API keys](#api-keys).

## Errors

Every error answer has the same body:

```json
{ "error": { "code": "too_many_requests", "message": "Too many requests. Try again later." } }
```

Branch on `code`, which is stable, and show `message` only to people. The OpenAPI document lists every code and the statuses each route can answer. Some answers also carry a `requestId`, which the server's log holds too. The common ones:

| Status | Codes | When |
|---|---|---|
| 400 | `invalid_request` | The request does not match its schema |
| 401 | `unauthorized` | No token or session, or one that is no longer valid |
| 402 | `payment_required`, `read_only` | On the cloud plan, a workspace that is not paid for. A self-hosted install never answers 402 |
| 403 | `origin_not_allowed`, `suspended`, `forbidden`, `blocked` | The site is not allowed or the widget is off, the workspace is suspended, the role does not allow it, or an operator blocked the visitor |
| 404 | `not_found` | It does not exist, or it is in another workspace |
| 409 | `conversation_closed`, `webhook_limit` | Reopen the conversation to reply, or the workspace has 5 webhooks already |
| 413 | `too_large` | The body is too large |
| 429 | `too_many_requests`, `too_many_streams` | A rate limit. Wait for the `Retry-After` header's seconds |
| 503 | `busy` | The server is overloaded for a moment. Try again |

In a read-only or suspended workspace, operators can read and export, and a write answers 402 `read_only` or 403 `suspended`. A route whose OpenAPI entry has `x-workspace-access: closed` still works then: presence, removing a member, revoking an invite and deleting the workspace.

## Sending without duplicates

A message or an image carries a `clientId` that the client makes, such as `m_4f9a2c`. A retry with the same `clientId` returns the first message and creates nothing, so a client can retry a send after any network error.

A widget send also answers `conversationStarted`: true when that message started a new conversation. A retry answers false.

## Visitors

The operator API's `Conversation` describes the visitor: `name`, `email`, `externalId`, `attributes` (the custom attributes your site signed), `blocked`, `device` (such as `"Chrome on macOS"`), `lastPage` and `lastSeenAt`. The conversation also has `pageContext`: what the page last sent with `Dinghy.setContext()`, or null. Your site does not sign it, so anyone can change it in their browser. Treat it as a hint, never as proof. A conversation's messages also answer `visitorOnline`: true while the visitor has a widget stream open, and null when the server cannot tell.

`POST /v1/widget/{key}/page` with `{ "page", "title" }` reports the page the visitor is on. The widget sends it only for a visitor who has chatted, when it loads and when the address changes. The server keeps the origin and path, never the query string or `#` part, up to 2,000 characters, and the title on one line, up to 200 characters. It stores nothing for a visitor with no conversation, and a host token sent here never creates a visitor. Each report adds a row to the visitor's page journey, unless it repeats the newest row's address, in which case it only fills in a new title. A visitor keeps the newest 100 rows, and the worker deletes rows after 90 days. The widget's `GET /v1/widget/{key}/me` answers `chatted`, true once the visitor has a conversation.

`POST /v1/widget/{key}/context` with `{ "context": { ... } }` sends what the page set with `Dinghy.setContext()`. It holds at most 20 keys of 1 to 40 characters, each with a string of up to 200 characters, a number, `true`, `false` or `null`. Each report replaces the last one. The widget sends it only for a visitor who has chatted, and again after the first message, and the server keeps it only for a visitor who has a conversation. It goes with the visitor's last conversation, as the page journey does.

A conversation's messages answer `visitorPages`: the visitor's newest 20 pages, newest first, each with `path` (origin and path), `title` (null when the page had none) and `viewedAt`.

`GET /v1/operator/workspaces/{workspaceId}/conversations/search?q=` searches open and closed conversations by the visitor's name, email or user ID and by message text, ignoring case. `q` has 3 to 100 characters, and the answer has at most 50 conversations, newest activity first. A conversation found by a message has that message's text as `lastMessage.body`, while `fromVisitor` and `createdAt` stay those of the newest message.

`GET /v1/operator/workspaces/{workspaceId}/analytics?days=30&tz=Europe/Paris` answers support numbers for any member. `days` is 7, 30 or 90, and `tz` is an IANA time zone, by default `UTC`. The period runs from the start of the day, `days - 1` days ago, in `tz`, to now, and every number is about the conversations that started in it: `started`, `closed` (closed now), `answered`, `firstReply` with `medianSeconds`, `p90Seconds` and `within5Minutes` (the share of `started` answered within 5 minutes, from 0 to 1), `perDay` (one `{ date, conversations }` per day, oldest first), `operators` (conversations by who sent the first reply, with `operatorId` or `apiKeyId`, `name` and `conversations`) and `hours` (7 rows, Monday first, of 24 counts by the hour each conversation started). A first reply is the conversation's first message from an operator or an API key, timed from the conversation's start. The numbers come from the stored conversations and messages; nothing tracks visitors for them.

`GET /v1/widget/{key}/presence` also answers `texts`: the workspace's own `title`, `greeting` and `away` text for the widget, each null for the default. Owners and admins set them with `PATCH /v1/operator/workspaces/{workspaceId}/settings` and `{ "widgetTexts": { "title", "greeting", "away" } }`, at most 40, 200 and 200 characters, where an empty text means the default.

## Live updates

A client receives with server-sent events. `GET /v1/widget/{key}/stream` and `GET /v1/operator/workspaces/{workspaceId}/stream` send:

- `message` (widget) or `change` (operator) events, whose `id` is the new cursor. A `change` for a new message has `fromVisitor`, true when the visitor wrote it,
- `ready` once the stream has caught up,
- `resync` when the client must load everything again, such as after a restore,
- `close`, with a reason, before the server ends the stream.

Pass the last cursor when you reconnect, and the stream replays what you missed. A stream lasts at most 15 minutes, and it sends a heartbeat every 25 seconds. The widget reads it with `fetch`, because `EventSource` cannot send a bearer token. [Architecture](architecture.md#messages-events-and-cursors) explains cursors.

## API keys

An API key lets a script or an AI agent work in one workspace without a person's session. An owner or admin creates one in **Settings > API**, and gives it a name, such as "Support bot". The token, which starts with `dk_`, shows once. Store it like a password. Dinghy keeps only its hash.

Send it as a bearer token. It needs no `Origin`, because a browser never sends this header on its own:

```sh
curl https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/conversations \
  -H "Authorization: Bearer dk_..."
```

A key has an agent's permissions, in its own workspace only. It can:

- list, search and read conversations, with the visitor and the page journey,
- reply with text or an image,
- close, reopen and assign a conversation.

A route that a key can call lists `apiKey` in its OpenAPI `security`. Any other route, such as settings, members, keys, webhooks, analytics, billing, export, deleting the workspace or `/v1/operator/me`, answers 403 `forbidden`. Another workspace's routes answer 404. An unknown or revoked key answers 401. Each key may send 300 requests a minute, and over that it gets 429 with `Retry-After`.

A reply sent with a key has `authorApiKeyId` set and `authorOperatorId` null, and `authorName` is the key's name. Visitors see it as a reply from your team, as they see any reply, without a name. Revoking a key in Settings stops it at once, and its old replies keep its name. **Last used** shows to the minute.

A token names its workspace: it is `dk_`, the workspace's ID, a dot, and a random part.

## Webhooks

A webhook sends a signed `POST` to your server when something changes in a workspace. An owner or admin adds one in **Settings > API**, with its address and the events it wants. A workspace has at most 5. The signing secret shows once, and **Replace secret** makes a new one. **Send test** sends a `webhook.test` event at once and shows the answer.

| Event | When |
|---|---|
| `conversation.created` | A visitor starts a conversation. Its first message also sends `message.created` |
| `message.created` | A visitor, an operator or an API key writes a message |
| `conversation.closed` | A conversation is closed |
| `conversation.reopened` | A conversation is reopened |
| `conversation.assigned` | A conversation's assignee changes, or is cleared |

The body is JSON:

```json
{
  "id": "6a0f3f1e-3c1b-4f6e-9d5a-2b7c8e9f0a1b",
  "type": "message.created",
  "createdAt": "2026-11-10T09:31:00.000Z",
  "workspaceId": "0b6f1c6e-2f4a-4c1e-9a57-3f1b8f0e6d21",
  "data": {
    "conversation": { "id": "...", "status": "open", "visitor": { "...": "..." }, "pageContext": null },
    "message": { "id": "...", "body": "Do you ship to Canada?", "fromVisitor": true, "authorName": null }
  }
}
```

`data.conversation` and `data.message` have the same shape as the operator API's `Conversation` and `InboxMessage`. Only `message.created` has `data.message`. They hold the state when the request is sent, which can be later than the change, such as after a retry.

Each request has these headers:

- `Dinghy-Event-Id`: the same as `id`. It stays the same on every retry and for every webhook, so drop an ID you have seen.
- `Dinghy-Signature`: `t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<body>` with the webhook's secret.

Check the signature on the raw body before you parse it, and refuse an old `t`. In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyDinghy(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const given = Buffer.from(parts.v1 ?? "", "hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) <= toleranceSeconds;
  return fresh && given.length === 32 && timingSafeEqual(given, Buffer.from(expected, "hex"));
}
```

Answer with any 2xx status within 10 seconds. Dinghy follows no redirect. Any other answer, or none, is tried again after 30 seconds, then after twice as long each time, up to an hour apart, for about a day. Delivery is at least once, so the same event can come twice, and events can come out of order. **Deliveries** in Settings shows each webhook's last 20, with their status, attempts and last error.

A webhook goes only to an `https` address on the public internet. Dinghy checks every address the name resolves to each time it sends, not only when you save it, and refuses this host, private networks and link-local addresses such as cloud metadata. A self-hosted install that sends to its own network can allow `http` and private addresses with [`WEBHOOK_ALLOW_PRIVATE`](self-hosting.md#settings).

## MCP

Dinghy is an [MCP](https://modelcontextprotocol.io) server, so an AI agent can read and answer your conversations. It lives at `/v1/mcp`, over Streamable HTTP, and it takes an [API key](#api-keys). The key's workspace is the one it works in, and its replies show the key's name.

To add it to Claude Code:

```sh
claude mcp add --transport http dinghy https://chat.example.com/v1/mcp --header "Authorization: Bearer dk_..."
```

Another client that supports remote servers over HTTP takes the same address and header. Many read a JSON file such as this one:

```json
{
  "mcpServers": {
    "dinghy": {
      "type": "http",
      "url": "https://chat.example.com/v1/mcp",
      "headers": { "Authorization": "Bearer dk_..." }
    }
  }
}
```

| Tool | What it does |
|---|---|
| `list_conversations` | Lists open or closed conversations, newest activity first. Pass `nextCursor` back as `cursor` for the next page |
| `search_conversations` | Finds conversations by the visitor's name, email or user ID, or by message text |
| `get_conversation` | Reads a conversation: its messages, the visitor, `pageContext` and the pages the visitor went through |
| `reply` | Replies in an open conversation. Pass the same `clientId` on a retry, so it is not sent twice |
| `close_conversation`, `reopen_conversation` | Closes or reopens a conversation |
| `assign_conversation` | Assigns a conversation to a member by operator ID, or clears it with `null` |

The server is stateless and answers JSON only: it keeps no session and opens no event stream, so `GET /v1/mcp` answers 405. A tool that fails answers with `isError: true` and the same stable `code` as the HTTP API, such as `not_found` or `conversation_closed`.
