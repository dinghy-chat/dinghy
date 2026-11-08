# API

Dinghy's widget and operator app use the same HTTP API that you can build on, for example a custom widget, a bot or an integration. Every install serves its full description as OpenAPI 3.1 at `/v1/openapi.json`, such as `https://chat.example.com/v1/openapi.json`. The same file is in the repository at [`apps/server/openapi.json`](../apps/server/openapi.json).

## Versions

Every route starts with `/v1`. Within `v1`, a release may add routes, fields and error codes. A change that would break a client is meant for a new version, and the [changelog](../CHANGELOG.md) names every API change.

## Two APIs and two ways to sign in

- **The widget API**, at `/v1/widget/{key}`, where `key` is the workspace's public key. It answers only pages whose `Origin` is on the workspace's allowed sites. `POST /v1/widget/{key}/visitors` creates a visitor and returns its browser token once. Other calls send it as `Authorization: Bearer <token>`. For a signed-in user, the bearer token is a host token that your site's server signs instead, as [Add the chat to your website](add-to-your-site.md#show-who-is-chatting) explains.
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

## Live updates

A client receives with server-sent events. `GET /v1/widget/{key}/stream` and `GET /v1/operator/workspaces/{workspaceId}/stream` send:

- `message` (widget) or `change` (operator) events, whose `id` is the new cursor,
- `ready` once the stream has caught up,
- `resync` when the client must load everything again, such as after a restore,
- `close`, with a reason, before the server ends the stream.

Pass the last cursor when you reconnect, and the stream replays what you missed. A stream lasts at most 15 minutes, and it sends a heartbeat every 25 seconds. The widget reads it with `fetch`, because `EventSource` cannot send a bearer token. [Architecture](architecture.md#messages-events-and-cursors) explains cursors.
