# API

Dinghy's widget and operator app use the same HTTP API that you can build on, for example a custom widget, a bot or an integration. Every install serves its full description as OpenAPI 3.1 at `/v1/openapi.json`, such as `https://chat.example.com/v1/openapi.json`. The same file is in the repository at [`apps/server/openapi.json`](../apps/server/openapi.json).

## Versions

Every route starts with `/v1`. Within `v1`, a release may add routes, fields and error codes. A change that would break a client is meant for a new version, and the [changelog](../CHANGELOG.md) names every API change.

## Two APIs and two ways to sign in

- **The widget API**, at `/v1/widget/{key}`, where `key` is the workspace's public key. It answers only pages whose `Origin` is on the workspace's allowed sites. `POST /v1/widget/{key}/visitors` creates a visitor and returns its browser token once. Other calls send it as `Authorization: Bearer <token>`. For a signed-in user, the bearer token is a host token that your site's server signs instead, as [Add the chat to your website](add-to-your-site.md#show-who-is-chatting) explains.
- **A reply email's chat page**, at `/chat/{token}` on the Dinghy server itself. Its page uses the widget API with the link's token, which starts with `dcl_`, as `Authorization: Bearer dcl_...`. The widget API takes that token only from the Dinghy server's own origin, or with no `Origin` header, and takes no other token from there. It works for 30 days.
- **The operator API**, at `/v1/operator`. It uses the session cookie that sign-in sets. Sign-in and sign-out live at `/v1/auth`: `POST /v1/auth/sign-in/magic-link` with `{ "email" }` emails a link, `POST /v1/auth/magic-link/verify` with `{ "token" }` uses one, which the button on the page the link opens does, and `POST /v1/auth/sign-out` ends the session. They pass through to the BetterAuth library, so their shape follows it and is not part of the versioned API. A request that changes something must also send the server's own `Origin`, so the operator API works only from the operator app's pages.

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

In a read-only or suspended workspace, operators can read and export, and a write answers 402 `read_only` or 403 `suspended`. A route whose OpenAPI entry has `x-workspace-access: closed` still works then: presence, removing a member, revoking an invite and deleting the workspace.
| 413 | `too_large` | The body is too large |
| 429 | `too_many_requests`, `too_many_streams` | A rate limit. Wait for the `Retry-After` header's seconds |
| 503 | `busy` | The server is overloaded for a moment. Try again |

## Sending without duplicates

A message or an image carries a `clientId` that the client makes, such as `m_4f9a2c`. A retry with the same `clientId` returns the first message and creates nothing, so a client can retry a send after any network error.

## Visitors

The operator API's `Conversation` describes the visitor: `name`, `email`, `externalId`, `attributes` (the custom attributes your site signed), `blocked`, `device` (such as `"Chrome on macOS"`), `lastPage` and `lastSeenAt`. A conversation's messages also answer `visitorOnline`: true while the visitor has a widget stream open, and null when the server cannot tell.

`POST /v1/widget/{key}/page` with `{ "page", "title" }` reports the page the visitor is on. The widget sends it only for a visitor who has chatted, when it loads and when the address changes. The server keeps the origin and path, never the query string or `#` part, up to 2,000 characters, and the title on one line, up to 200 characters. It stores nothing for a visitor with no conversation, and a host token sent here never creates a visitor. Each report adds a row to the visitor's page journey, unless it repeats the newest row's address, in which case it only fills in a new title. A visitor keeps the newest 100 rows, and the worker deletes rows after 90 days. The widget's `GET /v1/widget/{key}/me` answers `chatted`, true once the visitor has a conversation.

A conversation's messages answer `visitorPages`: the visitor's newest 20 pages, newest first, each with `path` (origin and path), `title` (null when the page had none) and `viewedAt`.

`GET /v1/operator/workspaces/{workspaceId}/conversations/search?q=` searches open and closed conversations by the visitor's name, email or user ID and by message text, ignoring case. `q` has 3 to 100 characters, and the answer has at most 50 conversations, newest activity first. A conversation found by a message has that message's text as `lastMessage.body`, while `fromVisitor` and `createdAt` stay those of the newest message.

`GET /v1/operator/workspaces/{workspaceId}/analytics?days=30&tz=Europe/Paris` answers support numbers for any member. `days` is 7, 30 or 90, and `tz` is an IANA time zone, by default `UTC`. The period runs from the start of the day, `days - 1` days ago, in `tz`, to now, and every number is about the conversations that started in it: `started`, `closed` (closed now), `answered`, `firstReply` with `medianSeconds`, `p90Seconds` and `within5Minutes` (the share of `started` answered within 5 minutes, from 0 to 1), `perDay` (one `{ date, conversations }` per day, oldest first), `operators` (conversations by who sent the first reply, with `operatorId`, `name` and `conversations`) and `hours` (7 rows, Monday first, of 24 counts by the hour each conversation started). A first reply is the conversation's first operator message, timed from the conversation's start. The numbers come from the stored conversations and messages; nothing tracks visitors for them.

`GET /v1/widget/{key}/presence` also answers `texts`: the workspace's own `title`, `greeting` and `away` text for the widget, each null for the default. Owners and admins set them with `PATCH /v1/operator/workspaces/{workspaceId}/settings` and `{ "widgetTexts": { "title", "greeting", "away" } }`, at most 40, 200 and 200 characters, where an empty text means the default.

## Live updates

A client receives with server-sent events. `GET /v1/widget/{key}/stream` and `GET /v1/operator/workspaces/{workspaceId}/stream` send:

- `message` (widget) or `change` (operator) events, whose `id` is the new cursor. A `change` for a new message has `fromVisitor`, true when the visitor wrote it,
- `ready` once the stream has caught up,
- `resync` when the client must load everything again, such as after a restore,
- `close`, with a reason, before the server ends the stream.

Pass the last cursor when you reconnect, and the stream replays what you missed. A stream lasts at most 15 minutes, and it sends a heartbeat every 25 seconds. The widget reads it with `fetch`, because `EventSource` cannot send a bearer token. [Architecture](architecture.md#messages-events-and-cursors) explains cursors.
