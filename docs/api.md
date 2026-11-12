# API

Dinghy's widget and operator app use the same HTTP API that you can build on, for example a custom widget, a bot or an integration. Every install serves its full description as OpenAPI 3.1 at `/v1/openapi.json`, such as `https://chat.example.com/v1/openapi.json`. The same file is in the repository at [`apps/server/openapi.json`](../apps/server/openapi.json).

## Versions

Every route starts with `/v1`. Within `v1`, a release may add routes, fields and error codes. A change that would break a client is meant for a new version, and the [changelog](../CHANGELOG.md) names every API change.

## Two APIs and the ways to sign in

- **The widget API**, at `/v1/widget/{key}`, where `key` is the workspace's public key. It answers only pages whose `Origin` is on the workspace's allowed sites. `POST /v1/widget/{key}/visitors` creates a visitor and returns its browser token once. Other calls send it as `Authorization: Bearer <token>`. For a signed-in user, the bearer token is a host token that your site's server signs instead, as [Add the chat to your website](add-to-your-site.md#show-who-is-chatting) explains.
- **A reply email's chat page**, at `/chat/{token}` on the Dinghy server itself. Its page uses the widget API with the link's token, which starts with `dcl_`, as `Authorization: Bearer dcl_...`. The widget API takes that token only from the Dinghy server's own origin, or with no `Origin` header, and takes no other token from there. It works for 30 days.
- **The operator API**, at `/v1/operator`. It uses the session cookie that sign-in sets. Sign-in and sign-out live at `/v1/auth`: `POST /v1/auth/sign-in/magic-link` with `{ "email" }` emails a link, `POST /v1/auth/magic-link/verify` with `{ "token" }` uses one, which the button on the page the link opens does, and `POST /v1/auth/sign-out` ends the session. They pass through to the BetterAuth library, so their shape follows it and is not part of the versioned API. A request that changes something must also send the server's own `Origin`, so with a session the operator API works only from the operator app's pages.
- **An API key**, for your own scripts and AI agents. It works on part of the operator API, with no session and no `Origin`, as `Authorization: Bearer dk_...`. See [API keys](#api-keys).
- **An OAuth access token**, which an MCP client such as Claude Code gets after an owner or admin approves it in the browser. It starts with `dko_` and works wherever an API key of its level works. See [OAuth](#oauth).

[Use Dinghy with AI agents](agents.md) explains how to connect an agent and what it should do.

## Errors

Every error answer has the same body:

```json
{ "error": { "code": "too_many_requests", "message": "Too many requests. Try again later." } }
```

Branch on `code`, which is stable, and show `message` only to people. The OpenAPI document lists every code and the statuses each route can answer. Some answers also carry a `requestId`, which the server's log holds too. The common ones:

| Status | Codes | When |
|---|---|---|
| 400 | `invalid_request`, `invalid_reply_to`, `bad_origin`, `not_a_member` | The request does not match its schema, a reply quotes a message that is not in its conversation, a site is not an `http` or `https` origin, or an operator ID is not in the workspace |
| 401 | `unauthorized` | No token or session, or one that is no longer valid |
| 402 | `payment_required`, `read_only` | On the cloud plan, a workspace that is not paid for. A self-hosted install never answers 402 |
| 403 | `origin_not_allowed`, `suspended`, `forbidden`, `blocked` | The site is not allowed or the widget is off, the workspace is suspended, the role or the key's level does not allow it, or an operator blocked the visitor |
| 404 | `not_found` | It does not exist, or it is in another workspace |
| 409 | `conversation_closed`, `webhook_limit`, `site_limit`, `grant_limit`, `message_seen` | Reopen the conversation to reply or to snooze it, the workspace has 5 webhooks, 20 allowed sites or 50 connected apps already, or the visitor has seen the reply you tried to edit |
| 409 | `human_handling`, `bots_paused`, `drafts_text_only` | For an API key: a person handles the conversation and the key sends directly, an owner or admin paused every bot, or a key in draft mode sent an image. See [Bots](#bots-reply-modes-drafts-notes-and-handoff) |
| 413 | `too_large` | The body is too large |
| 429 | `too_many_requests`, `too_many_streams` | A rate limit. Wait for the `Retry-After` header's seconds |
| 503 | `busy` | The server is overloaded for a moment. Try again |

In a read-only or suspended workspace, operators can read and export, and a write answers 402 `read_only` or 403 `suspended`. A route whose OpenAPI entry has `x-workspace-access: closed` still works then: presence, removing a member and revoking an invite. Deleting the workspace, with `x-workspace-access: always`, works in every state, also while a cloud workspace waits for its first payment. On Dinghy Cloud, an operator of a read-only workspace can still send a text reply in its welcome chat, which is the route with `x-workspace-access: welcome`; anywhere else it answers 402 `read_only`.

## Sending without duplicates

A message or an image carries a `clientId` that the client makes, such as `m_4f9a2c`. A retry with the same `clientId` returns the first message and creates nothing, so a client can retry a send after any network error.

A widget send also answers `conversationStarted`: true when that message started a new conversation. A retry of that message answers true too. A visitor who has no open conversation but a closed one writes into their newest closed one: the send reopens it, with its assignee, and answers false. Its status line and `conversation.reopened` event come before the message, with the visitor as the author. Only a visitor's first message starts a conversation.

### Close, reopen and snooze

`PATCH /v1/operator/workspaces/{workspaceId}/conversations/{conversationId}` takes one of:

- `{ "status": "closed" }` or `{ "status": "open" }` to close or reopen it.
- `{ "snooze": { "until": "2026-11-16T09:00:00.000Z" } }` to snooze an open conversation until a time, or `{ "snooze": { "until": null } }` until the visitor writes again. `{ "snooze": null }` ends a snooze.

A snoozed conversation stays open, and does not count as waiting for a reply until its time passes or the visitor writes. A reply from the team does not end it. A close ends it, and a reopen starts with none. Snoozing a closed conversation answers 409 `conversation_closed`. Each `Conversation` has `snooze`: `{ "until" }` while it is snoozed, with `until` null until the visitor writes, and null otherwise. A snooze writes a `conversation.snoozed` change to the operator stream, and the visitor hears nothing of it: no status line, no stream event and no webhook.

A message's `body` is plain text that the widget, the operator app and reply emails show as a small Markdown: `**bold**`, `*italic*`, `` `code` ``, blocks between lines of three backticks, `[words](https://...)` links, bare `http` and `https` addresses, and lists that start with `-`, `*`, `+` or `1.`. HTML, images and headings stay text, and only `http`, `https` and `mailto` links work. The API stores and answers the body as it was sent.

`POST /v1/operator/workspaces/{workspaceId}/conversations/{conversationId}/transcript` emails the visitor the whole conversation now, open or closed, whatever the `transcript` setting says. It answers 409 `no_email` when the visitor gave no email and `email_unavailable` when the server sends no email. It adds a `transcript.requested` event, and the worker sends it at least once, as it does reply emails. A transcript drops the visitor's waiting reply email, unless that email also carries a reply from another conversation. Transcripts go to visitors only, never to operators.

A message's `kind` is `text` or `image` for what people wrote, and `note` for a [note](#notes) that only the team sees. Closing or reopening a conversation writes a status line in the same transaction as its `conversation.closed` or `conversation.reopened` event and with the event's position, so the widget and the operator app show it in order: `kind` is `closed` or `reopened`, `body` is null, and the author is whoever made the change (an operator, an API key, or no one shown on Dinghy Cloud's welcome chat). A status line has no `message.created` event, so it raises no alert, no push and no webhook, it is never a conversation's `lastMessage`, and it counts toward neither unread replies nor first replies. A client that shows only chat skips these kinds.

An operator's first reply in a conversation with no assignee assigns it to them, with a `conversation.assigned` event. A reply with an API key never assigns.

### Notes

A note is a message that only the workspace's team sees. Send `"note": true` in the body of `POST .../conversations/{conversationId}/messages`, with a signed-in operator or an API key of either level, or use the MCP `add_note` tool. It takes the same `clientId` and `replyToMessageId` as a reply, and answers the same `InboxMessage`, with `kind` `note`. A note is text only: the image upload refuses a `note` with 400 `invalid_request`.

- A note goes in a closed conversation too, and leaves it closed. It never assigns the conversation, and an operator's first reply after it still does.
- The visitor never gets a note in any form: not in the widget's message list or stream, not as an edit or a delete there, not in a reply email or a transcript, and not as a quote, because a reply that quotes a note answers 400 `invalid_reply_to`. A note can quote any message, another note too.
- A note raises no push and no email. It is never a conversation's `lastMessage`, it does not stop a conversation from waiting, it does not move the conversation up the list, it is never unread, and it is not a first reply in analytics. Its receipt is always `{ "readAt": null, "emailedAt": null }`.
- Its author edits it at any time, as the visitor never sees it, and deletes it as a reply. An owner or admin deletes anyone's.
- Its `message.created`, `message.updated` and `message.deleted` events reach webhooks as any message's do, with `data.message.kind` set to `note`. On the operator stream, its `message.created` change has `fromVisitor` false.
- A workspace export keeps notes, with their kind.

### Quotes, edits and deletes

A send can quote one earlier message of the same conversation: pass its ID as `replyToMessageId` in the body of a text reply or the widget's send, in the query of an image upload, or to the MCP `reply` tool. It must be text or an image that was not deleted, or the send answers 400 `invalid_reply_to`. Every message then has `replyTo`, null or `{ id, authorName, fromVisitor, text, hasImage }`. `text` is the quoted message's whole text with its line breaks, with its Markdown marks removed. When the quoted message is deleted later, `id` is null and `text` is empty: show "Original message deleted". The widget API gives an operator's first name as `authorName`, and null for the visitor's own message.

`PATCH /v1/operator/workspaces/{workspaceId}/conversations/{conversationId}/messages/{messageId}` with `{ "body" }` changes the text of the signed-in operator's own text reply or note, and sets `editedAt`. It works only while the visitor has not seen the reply: it answers 409 `message_seen` once the visitor read it in the chat, or once a reply email or a transcript carried it or is being sent. A reply email still waiting reads the text when it goes, so it carries the edit. Nobody edits a visitor's message, and API keys and MCP cannot edit.

`DELETE` on the same path deletes a message: an operator deletes their own, and an owner or admin deletes anyone's, a visitor's too, such as a pasted card number. The row stays, so positions, receipts and quotes keep working: `deleted` is true, and `body` and `image` are null in every answer, webhook and export. Its image goes from storage as other deleted images do. API keys cannot delete.

An edit adds a `message.updated` event and a delete a `message.deleted` event, in the same transaction. The widget's stream and message list send the message again at that event's position, with its `seq` unchanged, so a client replaces its copy by `id` and keeps sorting by `seq`.

An operator message has `via`: `api` or `mcp` for a key's reply, `draft` for a draft an operator sent, and null otherwise. `readAt` is when the visitor's read position first passed a reply, null before that and for replies read before this field existed. `GET .../messages/{messageId}/receipt` answers `{ readAt, emailedAt }`, where `emailedAt` is when the first reply email or transcript after the reply went out.

## Visitors

The operator API's `Conversation` describes the visitor: `name`, `email`, `externalId`, `attributes` (the custom attributes your site signed), `blocked`, `device` (such as `"Chrome on macOS"`), `lastPage`, `lastSeenAt`, `country` (ISO 3166-1 alpha-2) and `timeZone` (IANA), the last two from the widget's beat. The conversation also has `pageContext`: what the page last sent with `Dinghy.setContext()`, or null. Your site does not sign it, so anyone can change it in their browser. Treat it as a hint, never as proof. A conversation's messages also answer `visitorOnline`: true while the visitor has a widget stream open, and null when the server cannot tell.

`POST /v1/widget/{key}/page` with `{ "page", "title" }` reports the page the visitor is on. The widget sends it only for a visitor who has chatted, when it loads and when the address changes. The server keeps the origin and path, never the query string or `#` part, up to 2,000 characters, and the title on one line, up to 200 characters. It stores nothing for a visitor with no conversation, and a host token sent here never creates a visitor. Each report adds a row to the visitor's page journey, unless it repeats the newest row's address, in which case it only fills in a new title. A visitor keeps the newest 100 rows, and the worker deletes rows after 90 days. The widget's `GET /v1/widget/{key}/me` answers `chatted`, true once the visitor has a conversation.

`POST /v1/widget/{key}/context` with `{ "context": { ... } }` sends what the page set with `Dinghy.setContext()`. It holds at most 20 keys of 1 to 40 characters, each with a string of up to 200 characters, a number, `true`, `false` or `null`. Each report replaces the last one. The widget sends it only for a visitor who has chatted, and again after the first message, and the server keeps it only for a visitor who has a conversation. It goes with the visitor's last conversation, as the page journey does.

`POST /v1/widget/{key}/beat` with `{ "tab", "page", "title", "referrer", "timeZone" }` says a tab of the site is open, for the live view. The loader sends it on load, once a minute while the tab shows, and when a chat starts, with the visitor's token when they have one. `tab` is 6 to 32 lowercase letters and digits that the page keeps in memory only. The server keeps the page's origin and path, the title, the referrer's origin unless it is the site's own and a known time zone, looks up the country of the request's address and drops the address, and keeps the tab in Valkey for 90 seconds after its last beat, at most 2,000 tabs a workspace. For a visitor with a token, it saves `country` and `timeZone` on the visitor. `POST /v1/widget/{key}/leave?tab=` drops a tab at once, and the loader sends it with `sendBeacon`. `GET /v1/operator/workspaces/{workspaceId}/visitors/live` lists the open tabs, newest first, with `visitor` (`id`, `name`, `email`, `externalId` and `conversationId`) for a visitor who has chatted, and `/visitors/live/count` counts them. Both answer null when Valkey cannot tell.

`POST /v1/widget/{key}/typing` with `{ "draft" }`, up to 2,000 characters, passes a visitor's unsent words to the workspace's open operator apps, which get it as a `notice`. It stores nothing, and does nothing for a visitor with no open conversation, a blocked visitor, or a workspace whose `typingPreview` is off. Owners and admins change that with `PUT /v1/operator/workspaces/{workspaceId}/widget/typing-preview` and `{ "enabled" }`, and the appearance answers `typingPreview`, so the widget sends nothing when it is off.

`GET /v1/operator/workspaces/{workspaceId}/contacts` lists the visitors who have a conversation, newest seen first, or with `sort=firstSeen` newest first. `q` matches the name, email or user ID, and `limit` is 1 to 100. Each contact has `company` (the signed `company` attribute), `country`, `timeZone`, `lastSeenAt`, `createdAt` and `conversationCount`, and the answer's `next` goes in `before` for the next page. `GET .../contacts/export` downloads them all as CSV, with every cell that a spreadsheet would read as a formula starting with a quote mark. `GET .../contacts/{visitorId}` adds `online` (null when the server cannot tell), `attributes`, `pageContext`, the team's private `note`, the pages, and every conversation with `messageCount`, `assigneeName`, `closedBy` (the member or API key that closed it, null while open or when the visitor closed it) and `firstReplySeconds`. `PATCH` on it changes `note`, and for a visitor your site did not sign in, `name` and `email`. A signed-in visitor's name and email answer `signed_in`. Owners and admins `DELETE` a contact with all their conversations, messages and images.

A conversation's messages answer `visitorPages`: the visitor's newest 20 pages, newest first, each with `path` (origin and path), `title` (null when the page had none) and `viewedAt`. They also answer `welcome`, which is null except on Dinghy Cloud's welcome chat (see [Architecture](architecture.md#core-and-ee)). On the new workspace's side, `welcome` is `{ "with": "founder", "pictureUrl" }`, and the conversation's `visitor.pictureUrl` holds the same picture, in lists too. Every other visitor's `pictureUrl` is null. And they answer `receipts`: how far the visitor has seen the replies, as message positions. A reply at or below `readSeq` was read in the chat. Each entry of `emails` is a reply email or a transcript, with the positions of the first and last message it carried, `fromSeq` and `toSeq`, and `sent`. A reply inside a sent one's range went out by email, and one inside only failed ones' ranges was in an email that failed. A reply in none and above `readSeq` is stored only.

`GET /v1/operator/workspaces/{workspaceId}/get-started` answers which first steps are done for the signed-in member: `install`, `logo`, `widget`, `team`, `notifications` and `chat`, and `dismissed`. `POST .../get-started/dismiss` hides them for that member.

`GET /v1/operator/workspaces/{workspaceId}/conversations` answers `waiting`, the open conversations whose newest message is the visitor's and that are not snoozed, `snoozeEndsInMs`, the milliseconds until the workspace's next timed snooze ends (null with none), after which `waiting` can change with no change on the stream, and `openBy`, the open conversations for each filter: `all`, `mine` (always 0 for an API key) and `unassigned`. `GET /v1/operator/waiting` answers `waiting` for each of the signed-in operator's workspaces, for the workspace menu.

Each operator has their own read position in each conversation. A `Conversation` has `unread`, true when a visitor message that is not deleted is past the signed-in operator's position, and always false for an API key. `POST /v1/operator/workspaces/{workspaceId}/conversations/{conversationId}/read` with `{ "seq" }`, a message's `seq`, moves the position forward to it, never back and never past the newest message. Only a signed-in operator calls it; an API key gets 403.

`GET /v1/operator/workspaces/{workspaceId}/conversations/search?q=` searches open and closed conversations by the visitor's name, email or user ID and by message text, ignoring case. `q` has 3 to 100 characters, and the answer has at most 50 conversations, newest activity first. A conversation found by a message has that message's text as `lastMessage.body`, while `fromVisitor` and `createdAt` stay those of the newest message.

`GET /v1/operator/workspaces/{workspaceId}/analytics?days=30&tz=Europe/Paris` answers support numbers for any member and any API key. `days` is 7, 30 or 90, and `tz` is an IANA time zone, by default `UTC`. The period runs from the start of the day, `days - 1` days ago, in `tz`, to now, and every number is about the conversations that started in it: `started`, `closed` (closed now), `answered`, `firstReply` with `medianSeconds`, `p90Seconds` and `fast` (how many of `started` got a first reply within 5 minutes), `perDay` (one `{ date, conversations }` per day, oldest first), `repliers` (conversations by who sent the first reply, most first: `{ kind: "operator", operatorId, name }`, `{ kind: "api_key", apiKeyId, name }`, or one `{ kind: "former" }` for deleted operators, each with `conversations`) and `hours` (7 rows, Monday first, of 24 counts by the hour each conversation started), and `previous`, with `started` and `firstReply` (`medianSeconds` and `fast`) for a period of the same length just before, which ends `days` days ago, to compare with. A first reply is the conversation's first message from an operator or an API key, timed from the conversation's start. The numbers come from the stored conversations and messages; nothing tracks visitors for them. On Dinghy Cloud, the welcome chat counts nowhere, and [test visitors](#install-and-test-visitors) count nowhere either.

## The widget's look

`GET /v1/operator/workspaces/{workspaceId}/widget` answers the widget's settings to any member and to a Full access key. Owners, admins and Full access keys replace them with `PUT` on the same address, with every field:

| Field | Value |
|---|---|
| `title`, `greeting`, `away` | The widget's own words, at most 40, 200 and 200 characters on one line, or null for Dinghy's |
| `primary`, `accent` | A full hex color, such as `#0b2239`, or null for Dinghy's |
| `position` | `left` or `right` |
| `theme` | `light`, `dark` or `auto`, which follows the visitor's device |
| `launcher` | `bubble`, `label`, `square`, `boat` or `hidden` |
| `radius` | The corners in pixels, a whole number from 0 to 24 |
| `mascot` | Whether the open chat shows the boat |
| `emailAsk` | `off`, `after_first` or `before_first`: when a signed-out visitor is asked for an email |
| `branding` | Whether the chat shows "Powered by Dinghy" |
| `transcript` | Whether a visitor with an email gets the whole conversation by email 5 minutes after it closes, when someone on the team replied. A reopen within the 5 minutes cancels it, and a later close sends another only after new messages |
| `sound` | Whether the widget plays a soft chime for a reply that arrives while the chat is closed or its tab is hidden |

Both answer the settings with `logoUrl` and `team`: up to 3 members who sent the latest replies, each with an `id` that matches the `authorId` on their replies, a first name and a picture's address. `PUT .../widget/logo` sets the logo from the raw body, a PNG, JPEG or WebP of at most 2 MB, and `DELETE .../widget/logo` removes it. No API key can reach the logo routes.

`GET /v1/widget/{key}/appearance` answers the same, with no `Origin` check, because the widget shows all of it. Any site may read it. It caches for 5 minutes, so a saved change reaches sites within 5 minutes, and it answers 304 to a matching `If-None-Match`. A workspace whose widget is off, or an unknown key, answers 404. `GET /v1/widget/{key}/presence` answers only `online`, `members`, `emailReplies` and `replySeconds`. `members` lists the members online now, who are not away, by the same hash as `authorId` on their replies, so the widget can mark their faces. `replySeconds` is the 30-day median first reply time while `headerStatus` is `reply_time` and someone is online, and null otherwise. Only an open chat asks for presence, every 30 seconds, so a page view never computes it. The appearance's `faces` are the header's candidates: every member for `headerFaces` `online`, latest repliers first, which the widget cuts to those online, the latest repliers for `repliers`, and the chosen members for `chosen`.

A message in the widget API has `fromBot`, true for a reply sent with an API key, `authorId`, a hash that tells authors apart and names none, `authorName`, the operator's first name or the key's name, and `authorPictureUrl`. A deleted account's replies keep the name "Former team member" and have no picture. These fields are null for the visitor's own messages.

An operator sets their picture with `PUT /v1/operator/me/picture` and the raw body, a PNG, JPEG or WebP of at most 2 MB, and removes it with `DELETE`. The server cuts it to a 128-pixel square. `GET /v1/operator/me` and the members list answer `pictureUrl`, and `GET /v1/pictures/{operatorId}` serves it to anyone.

## Live updates

A client receives with server-sent events. `GET /v1/widget/{key}/stream` and `GET /v1/operator/workspaces/{workspaceId}/stream` send:

- `message` (widget) or `change` (operator) events, whose `id` is the new cursor. A `change` for a new message has `fromVisitor`, true when the visitor wrote it. An edited or deleted message comes again as a widget `message`, and as a `message.updated` or `message.deleted` operator `change`,
- `ready` once the stream has caught up,
- `resync` when the client must load everything again, such as after a restore,
- `close`, with a reason, before the server ends the stream,
- on the operator stream, `notice` events with no `id`: `{ "kind": "typing", conversationId, visitorId, draft }` while a visitor types, with an empty `draft` when they stop, `{ "kind": "bot_typing", conversationId, name, typing }` while an API key's bot writes, and `{ "kind": "receipts", visitorId }` when a visitor read replies or a reply email went out. A notice can be lost, so treat it as a hint to load again,
- on the widget stream, `notice` events with no `id`: `{ "kind": "typing", name, typing }` while an API key's bot writes a reply, and with `typing: false` when it stops.

Pass the last cursor when you reconnect, and the stream replays what you missed. A stream lasts at most 15 minutes, and it sends a heartbeat every 25 seconds. The widget reads it with `fetch`, because `EventSource` cannot send a bearer token. [Architecture](architecture.md#messages-events-and-cursors) explains cursors.

## API keys

An API key lets a script or an AI agent work in one workspace without a person's session. An owner or admin creates one in **Settings > API & webhooks**, and gives it a name, such as "Support bot", a level and a reply mode. The token, which starts with `dk_`, shows once. Store it like a password. Dinghy keeps only its hash. An MCP client can instead get a token in the browser, with [OAuth](#oauth). Such a connected app is a key too, and everything in this section applies to it.

Send it as a bearer token. It needs no `Origin`, because a browser never sends this header on its own:

```sh
curl https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/conversations \
  -H "Authorization: Bearer dk_..."
```

A key works in its own workspace only, at the access level chosen when it was made. There are two, which the operator app calls **Chats** and **Full access**, and the API calls `conversations` and `setup`, in `level`, in OAuth scopes and in the OpenAPI enums. **Chats**, the default, has a member's permissions. It can:

- list, search and read conversations, with the visitor and the page journey (`?assignee=none` lists the unassigned ones; a key is assigned nothing, so `assignee=me` answers 400),
- reply with text or an image, as its reply mode says, write notes, hand a conversation to people and show that it types (see [Bots](#bots-reply-modes-drafts-notes-and-handoff)),
- close, reopen, snooze and assign a conversation,
- read contacts, the visitors on the site now and the analytics, and stream events from [`GET /v1/events`](#events-for-api-keys).

**Full access** can do all of that, and set the workspace up: the [webhooks](#webhooks) (list, add, change, delete, replace a secret, send a test, read and replay the deliveries), the widget's look, and the [install routes and test visitors](#install-and-test-visitors). It lets an agent, such as a coding agent working on your site, connect Dinghy by itself. To let an agent set up Dinghy, create a Full access key.

A route that every key can call lists `apiKey` in its OpenAPI `security`, and a route that only a Full access key can call lists `setupKey`. A Chats key on such a route answers 403 `forbidden`. Every other route, such as members, keys, billing, export, deleting the workspace, sending or discarding a draft, giving a conversation back, pausing bots or `/v1/operator/me`, answers 403 `forbidden` to any key: no key can create, list or revoke keys, and no key reads the signing secret. Another workspace's routes answer 404. An unknown, expired or revoked key answers 401. Each key may send 300 requests a minute, across the API, MCP and the event stream, and over that it gets 429 with `Retry-After`.

`POST .../api-keys` takes `name`, `level` (`conversations` or `setup`) and `replyMode` (`send` or `draft`, by default `draft`). `PATCH .../api-keys/{keyId}` changes `name`, `level` or `replyMode`, and `DELETE` revokes the key or disconnects the app. Only owners and admins call them, with a session. The key list answers each key's `level`, `replyMode`, `source` (`static` for a key made in Settings, `oauth` for a connected app), `client` (null for a key, else a connected app's `kind`, `host` and `local`: `cimd` names the host that published the app, `dcr` the host or scheme it returns to, and `local` is true when that is the user's own computer), `createdByName` (who made the key or approved the app) and `lastUsedAt`.

A reply sent with a key has `authorApiKeyId` set and `authorOperatorId` null, and `authorName` is the key's name. Visitors see the key's name on it, with a bot icon. Revoking a key in Settings stops it at once, and its old replies keep its name. Settings shows when each key was last used.

A token names its workspace: it is `dk_`, the workspace's ID, a dot, and a random part.

## OAuth

Dinghy is its own OAuth 2.1 authorization server, as the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) of 2026-07-28 describes. An MCP client connects with no token, and the person approves it in the browser. [Use Dinghy with AI agents](agents.md#connect) shows the steps. OAuth is on when `PUBLIC_URL` is `https`, or a loopback address such as `http://localhost:3000`, because OAuth 2.1 forbids an `http` issuer anywhere else. When it is off, API keys still work. It needs no other setting.

The issuer is the origin of `PUBLIC_URL`, such as `https://chat.example.com`, and the one resource is `https://chat.example.com/v1/mcp`. A client must use that address: through another name, the resource does not match.

### Discovery

- `POST /v1/mcp` with no token answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://chat.example.com/.well-known/oauth-protected-resource/v1/mcp", scope="conversations"`. With a token that is not valid, expired or revoked, it adds `error="invalid_token"`, so the client refreshes.
- `GET /.well-known/oauth-protected-resource/v1/mcp`, and the same at `/.well-known/oauth-protected-resource`, answer the resource, the authorization server, `scopes_supported` and `bearer_methods_supported: ["header"]`.
- `GET /.well-known/oauth-authorization-server` answers the issuer and the endpoints: `/oauth/authorize`, `/v1/oauth/token`, `/v1/oauth/register` and `/v1/oauth/revoke`. It supports the `code` response type, the `authorization_code` and `refresh_token` grants, PKCE with `S256` only, and public clients only (`token_endpoint_auth_methods_supported: ["none"]`). It sets `client_id_metadata_document_supported` and `authorization_response_iss_parameter_supported` to true.

### Clients

A client names itself in one of two ways:

- **A Client ID Metadata Document**, which the spec prefers: its `client_id` is an `https` URL with a path, such as `https://claude.ai/oauth/claude-code-client-metadata`. Dinghy fetches it only after the person signs in, from public addresses only, with no redirect, within 5 seconds and 5 KB, and keeps it for an hour. The document's `client_id` must equal the URL, and its `redirect_uris` must hold the one the request uses.
- **Dynamic Client Registration**: `POST /v1/oauth/register` with RFC 7591 metadata: `redirect_uris` (1 to 5) and an optional `client_name`. It ignores fields it does not use. It answers 201 with a `client_id` that holds the name and the addresses, signed by the server, so Dinghy stores nothing. A client always gets `token_endpoint_auth_method: "none"` and no secret. A client address may register 10 times an hour.

A redirect URI is `https` on any host, `http` on `localhost`, `127.0.0.1` or `[::1]` (where only the port may differ from the registered one), or a private-use scheme with a dot, such as `com.example.app:/callback`. Dinghy refuses one with a fragment or user info, and `javascript:`, `data:` and `file:`.

### Scopes and levels

The scopes are `conversations` (Chats) and `setup` (Full access), the two key levels. The consent page preselects the level from `scope`, and the person may change it. A Full access grant's tokens carry the scope `conversations setup`. Dinghy ignores scopes it does not know, such as `offline_access`, and always gives a refresh token. A Chats token does not see the Full access tools in MCP, and on a `setupKey` route it gets 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="setup"`.

### Consent

`GET /oauth/authorize` is a page of the operator app, with the usual query: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and optional `state`, `scope` and `resource`. A `resource` must be the MCP address or the origin, or the page answers `invalid_target`. A `client_id` or `redirect_uri` that is not valid shows an error page and never redirects. The page asks the person to sign in first, then shows the app's name, a workspace picker with the workspaces where they are an owner or admin, the access (Chats or Full access) and the reply mode.

**Approve** sends `POST /v1/operator/workspaces/{workspaceId}/oauth/grants` with the session, and **Cancel** sends `POST /v1/operator/oauth/deny`. Both answer `{ redirectTo }`, with `code` or `error=access_denied`, and `state` and `iss`. Approving makes a connected app, a key with `source: "oauth"` named after the app, in **Drafts only** unless the person chose **Send directly**. When the same person approves the same app again, Dinghy replaces their earlier grant only if it no longer has a live token, so the same app on a second computer keeps the first one's grant. A workspace has at most 50 connected apps, and the 51st answers 409 `grant_limit`.

### Tokens

`POST /v1/oauth/token` takes a form body (`application/x-www-form-urlencoded`), and its answers carry `Cache-Control: no-store`:

- `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri` and optional `resource`. A code works once, for 60 seconds. A second use revokes the grant.
- `grant_type=refresh_token` with `refresh_token`, and optional `client_id` and `resource`. Each refresh gives a new refresh token. The old one works once more within 60 seconds, for two processes that refresh at once or a lost answer. After that, a second use revokes the grant.

It answers `access_token`, `token_type: "Bearer"`, `expires_in`, `refresh_token` and `scope`. An access token, `dko_...`, lasts 1 hour, and a refresh token, `dkr_...`, 30 days. Both name their workspace, as `dk_` keys do, and Dinghy keeps only their hashes. A client address may send 60 token requests a minute.

`POST /v1/oauth/revoke` (RFC 7009) takes `token` and optional `client_id`, and revokes the grant that the access or refresh token belongs to. It answers 200, also for a token it does not know.

Errors on these routes have OAuth's shape, `{ "error", "error_description" }`, not Dinghy's: `invalid_request`, `invalid_grant` (a code or refresh token that is not valid, expired or used), `unsupported_grant_type`, `invalid_target`, `invalid_client_metadata`, `invalid_redirect_uri`, and `temporarily_unavailable` with 429 over a limit.

### Where a token works

An access token works as a key of its grant's level: on `/v1/mcp`, on every operator route that such a key may call, and on `GET /v1/events`. A refresh token or a code never works as a bearer token. A grant ends when someone revokes it in **Settings > API & webhooks**, when the app revokes it, when a token is replayed as above, and when the person who approved it leaves the workspace, loses the owner or admin role, or deletes their account. The worker deletes expired tokens once a day, and grants whose code nobody redeemed within an hour.

## Bots: reply modes, drafts, notes and handoff

These routes let an API key's bot answer chats while people stay in control. The MCP tools of the same names do the same.

### Reply modes and drafts

Each key has a `replyMode`. With `send`, a reply goes to the visitor. With `draft`, `POST .../conversations/{conversationId}/messages` answers 202 with `{ draft }` and nothing reaches the visitor: the draft waits under the conversation's last message for an operator. A key in draft mode cannot send an image, which answers 409 `drafts_text_only`. A key made before reply modes existed sends; a new key or connected app drafts unless an owner or admin chooses otherwise.

A draft has `id`, `conversationId`, `apiKeyId`, `authorName`, `clientId`, `body`, `replyToMessageId`, `status` and times. `status` is `open`, `stale` (the visitor or an operator wrote after it), `sent` or `discarded`. With a session:

- `GET .../conversations/{conversationId}/drafts` lists the open and stale drafts, newest first.
- `POST .../drafts/{draftId}/send`, with an optional `{ "body" }` to edit it, sends it as the operator's own reply, with `via: "draft"`. It answers 201 with the message, and 200 with the same message when it was sent before, by any operator, so the visitor never gets it twice. Sending approves the bot's words, so the bot keeps the conversation. The other drafts that wait become stale.
- `POST .../drafts/{draftId}/discard` discards it.

Keys cannot send or discard drafts. The MCP `list_drafts` tool shows a key the drafts and what became of them.

### Human handling

A person handles a conversation from when an operator replies in text or with an image, or a bot hands it off. A conversation's `handler` says who handles it:

- `{ kind: "person", operatorId, name, since }`: a person handles it, and it is assigned to this member.
- `{ kind: "team", since }`: a person handles it, and it is assigned to no one.
- `{ kind: "bot", apiKeyId, name }`: no person handles it, and this key took part last, with a message, a draft, a note or a handoff.
- null: no person handles it, and no bot took part.

A conversation's `bot` is `{ apiKeyId, name }` of the key that took part last, whoever handles it now, or null when no key did. It is the bot that a person can give the conversation back to.

While a person handles it, a key that sends directly gets 409 `human_handling` on a reply and on typing. A key in draft mode may still write drafts, as suggestions.

People pick who handles a conversation with two routes, with a session only:

- `POST .../conversations/{conversationId}/give-back` gives it back to the bots. In one transaction it clears the assignee, with a `conversation.assigned` event when there was one, and makes no person handle it, with a `conversation.given_back` event.
- `PUT .../conversations/{conversationId}/assignee` with `{ "operatorId": "<member>" }`, or `null` for the whole team, takes it over. In one transaction it sets the assignee, with a `conversation.assigned` event, and makes a person handle it, as a reply does. With an API key the same route changes only the assignee, and the bot keeps answering.

### Handoff

`POST .../conversations/{conversationId}/handoff`, with an API key only, takes `clientId`, `reason` (up to 500 characters), and optional `summary` (up to 2,000), `operatorId` and `visitorMessage`. In one transaction, it sends `visitorMessage` as the key's reply (or a draft in draft mode), assigns the conversation to `operatorId`, makes a person handle it, adds a note with the reason and the summary, and adds a `conversation.handoff` event. The note's `handoff` is `{ operatorId }`: the member it went to, or null for the whole team. Every other message has `handoff: null`. That event alerts the assignee, or every member with alerts on when there is none, as a new visitor message does. It answers 201 with `visitorMessage`: `{ status: "sent", message }`, `{ status: "drafted", draft }`, `{ status: "not_sent", reason: "bots_paused" }` or null. A retry with the same `clientId` answers 200 with the first result and changes nothing, even when bots were resumed since.

### Notes from bots

A key writes a [note](#notes) as an operator does, with `"note": true` or the MCP `add_note` tool. A note is never refused with `human_handling` or `bots_paused`, so a bot can pass on what it found while a person handles the conversation. An operator's note does not make a person handle the conversation, and it does not make drafts stale: only a reply that reaches the visitor does. The operator app shows each link in a key's note as plain text with its address, so a link that a visitor gave a bot cannot pass as the team's.

### Pause all bots

`PUT .../bots-paused` with `{ "paused": true }`, from an owner or admin with a session, pauses every bot of the workspace. While paused, every key's reply, draft and typing answer 409 `bots_paused`. Reads, notes and handoffs still work. The workspace lists answer `botsPaused`, `botsPausedBy`, the name of who paused them, and `botsPausedAt`, when. The route answers `{ paused, pausedBy }`.

### Typing

`POST .../conversations/{conversationId}/typing` with `{ "typing": true }`, from an API key only, shows the visitor "<name> is typing" for 6 seconds, or until the next message. Repeat it while the bot writes, and send `false` to stop. It stores nothing. A key in draft mode shows it to operators only. It is refused like a reply, with `bots_paused` or `human_handling`.

## Events for API keys

`GET /v1/events` streams the workspace's events to an API key, as server-sent events, for a bot with no public address. Each event's name is its webhook type, its `id` is its position, and its data is `{ type, workspaceId, data }`, with the same `data` as a [webhook body](#webhooks). `?types=message.created,conversation.handoff` keeps only those types.

```sh
curl -N "https://chat.example.com/v1/events?types=message.created" \
  -H "Authorization: Bearer dk_..."
```

With no position, it starts from now. Reconnect with `Last-Event-ID`, or `?after=` and the last `id`, and it sends what you missed. One change can make two events: a conversation's first message sends `conversation.created`, then `message.created`. The first has the position `generation.seq.0`, and the last has the change's cursor, `generation.seq`, so a stream that drops between them sends the second when it resumes. `ready` comes when it has caught up, and `resync` when the cursor is too old: read the open conversations again. It sends a heartbeat every 25 seconds, ends after 15 minutes with a `close` event, and takes a slot in the workspace's stream limit, so too many streams answer 429 `too_many_streams`. A revoked key's stream ends within 25 seconds. A `notice` has no `id` and may be lost: `{ "kind": "typing", conversationId, draft }` carries a visitor's unsent words, only while the workspace's typing preview is on. Messages from test visitors come with `conversation.visitor.isTest: true`.

## Install and test visitors

These routes help a person or a Full access key put the widget on a site. They are under `/v1/operator/workspaces/{workspaceId}`, and owners, admins and Full access keys can call them.

| Route | What it does |
|---|---|
| `GET /install/snippet?framework=` | The code that adds the widget, for `html`, `nextjs`, `react`, `vue`, `rails`, `laravel` or `wordpress`: `code`, the `file` it goes in, the `placement` in that file, `notes`, and the public key and server address it holds |
| `GET /install/check?origin=` | Whether the widget is installed: `allowed` (whether `origin` is an allowed site, null without one), `widgetSeenAt`, `sites` (allowed sites and sites that loaded the widget, with `firstSeenAt` and `lastSeenAt`, written at most once an hour), `refused` (origins whose widget calls were refused in the last 24 hours, a hint only), `liveTabs` and `nextStep` |
| `GET /install/identity?language=` | Server code that signs the token for `Dinghy.identify()`, for `typescript`, `python`, `ruby`, `php` or `go`. It reads the secret from `DINGHY_SIGNING_SECRET`, and never contains it: `secretNote` says where a person puts it |
| `GET /sites` | The allowed sites, as `{ sites }` |
| `POST /sites` | `{ "origin" }` allows one more origin. A workspace has at most 20: 409 `site_limit` past that, and 400 `bad_origin` for anything that is not an `http` or `https` origin without a path |
| `DELETE /sites?origin=` | Stops the widget on an origin. Its open chats end at their next check |
| `POST /test-visitors/messages` | `{ "body", "name", "conversationId" }`, the last two optional, sends a message as a test visitor through the widget's own path, and answers `{ visitorId, conversationId, message }`. Without `conversationId`, a new test visitor starts a conversation. A workspace may send 10 a minute |
| `DELETE /test-visitors` | Deletes every test visitor, with their conversations, messages and images, and answers `{ deleted }` |

A test visitor has `isTest: true`, and the inbox shows a **Test** label. Webhooks, `/v1/events` and `wait_for_messages` see test visitors, so a bot can be tested from end to end. Analytics, contacts, live counts, push and email alerts and transcripts leave them out.

## Webhooks

A webhook sends a signed `POST` to your server when something changes in a workspace. An owner or admin adds one in **Settings > API & webhooks**, with its address and the events it wants, or a [Full access key](#api-keys) adds one with the same routes. Each webhook answers `createdBy`: `{ "kind": "operator" | "key", "name" }`, or null for one from an older release, and Settings shows it. A workspace has at most 5. The signing secret shows once, and **Replace secret** makes a new one. **Send test** sends a `webhook.test` event at once and shows the answer.

| Event | When |
|---|---|
| `conversation.created` | A visitor starts a conversation. Its first message also sends `message.created` |
| `message.created` | A visitor, an operator or an API key writes a message or a note |
| `message.updated` | An operator edits a reply or a note |
| `message.deleted` | An operator deletes a message. `data.message` has `deleted: true` and no body |
| `conversation.closed` | A conversation is closed |
| `conversation.reopened` | A conversation is reopened |
| `conversation.assigned` | A conversation's assignee changes, or is cleared |
| `conversation.handoff` | An API key's bot handed the conversation to people |
| `conversation.given_back` | An operator gave the conversation back to the bots |

Drafts send no webhook. The body is JSON:

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

`data.conversation` and `data.message` have the same shape as the operator API's `Conversation` and `InboxMessage`. Only the `message.*` events have `data.message`. They hold the state when the request is sent, which can be later than the change, such as after a retry. A test visitor's conversation has `visitor.isTest: true`.

Each request has these headers:

- `Dinghy-Event-Id`: the same as `id`. It stays the same on every retry and replay, and for every webhook, so drop an ID you have seen.
- `Dinghy-Signature`: `t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<body>` with the webhook's secret.

Check the signature on the raw body before you parse it, compare in constant time, and refuse a `t` older than 5 minutes. Keep the secret in your server's environment. The MCP tool `get_webhook_verification` gives the same code.

In TypeScript, with Node or Bun:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

/** True when the request came from Dinghy. Pass the raw body, before any JSON parsing. */
export function isFromDinghy(rawBody: string, header: string | null, secret: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (match === null) return false;
  const [, timestamp = "", received = ""] = match;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
```

In Python:

```python
import hashlib
import hmac
import re
import time

TOLERANCE_SECONDS = 300


def is_from_dinghy(raw_body: bytes, header: str, secret: str) -> bool:
    """True when the request came from Dinghy. Pass the raw body, before any JSON parsing."""
    match = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if match is None:
        return False
    timestamp, received = match.group(1), match.group(2)
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return False
    signed = timestamp.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received)
```

In Go:

```go
package dinghy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"time"
)

const toleranceSeconds = 300

var signaturePattern = regexp.MustCompile("^t=(\\d+),v1=([0-9a-f]{64})$")

// IsFromDinghy reports whether a request came from Dinghy. Pass the raw body, before any parsing.
func IsFromDinghy(rawBody []byte, header, secret string) bool {
	match := signaturePattern.FindStringSubmatch(header)
	if match == nil {
		return false
	}
	timestamp, err := strconv.ParseInt(match[1], 10, 64)
	age := time.Now().Unix() - timestamp
	if err != nil || age > toleranceSeconds || age < -toleranceSeconds {
		return false
	}
	received, err := hex.DecodeString(match[2])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(match[1] + "."))
	mac.Write(rawBody)
	return hmac.Equal(mac.Sum(nil), received)
}
```

Answer with any 2xx status within 10 seconds. Dinghy follows no redirect. Any other answer, or none, is tried again after 30 seconds, then after twice as long each time, up to an hour apart, for about a day. Delivery is at least once, so the same event can come twice, and events can come out of order.

**Deliveries** in Settings, and `GET .../webhooks/{webhookId}/deliveries`, show each webhook's last 20, with their `status` (`pending`, `sent` or `failed`), attempts, the last HTTP status and error, and `responseExcerpt`: the first 2 KB of the receiver's last refusing answer, as UTF-8 with control characters removed. **Replay**, or `POST .../webhooks/{webhookId}/deliveries/{deliveryId}/replay`, sends the delivery's event again now, as a new delivery with the same `Dinghy-Event-Id`, `replayOf` set to the first one and `replayedAt` set to now. Its body keeps the event's own `createdAt`, so a receiver sees when the change happened. It answers 201 with the new delivery, which is retried for a day from the replay, like any other delivery.

A webhook goes only to an `https` address on the public internet. Dinghy checks every address the name resolves to each time it sends, not only when you save it, and refuses this host, private networks and link-local addresses such as cloud metadata. A self-hosted install that sends to its own network can allow `http` and private addresses with [`WEBHOOK_ALLOW_PRIVATE`](self-hosting.md#settings).

## MCP

Dinghy is an [MCP](https://modelcontextprotocol.io) server, so an AI agent can install Dinghy on a site, and read and answer your conversations. It lives at `/v1/mcp`, over Streamable HTTP. It takes an [OAuth](#oauth) access token or an [API key](#api-keys). The token's workspace is the one it works in, and its replies show the key's or the app's name.

To add it to Claude Code, with OAuth in the browser:

```sh
claude mcp add --transport http dinghy https://chat.example.com/v1/mcp
```

Or with an API key, for a server or CI:

```sh
claude mcp add --transport http dinghy https://chat.example.com/v1/mcp --header "Authorization: Bearer dk_..."
```

Another client that supports remote servers over HTTP takes the same address, and the same header for a key. Many read a JSON file such as this one:

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

Every key and connected app gets the Chats tools. A Full access one also gets the Full access tools. A Chats `tools/list` does not include the Full access tools, and calling one answers that there is no such tool.

| Tool | Level | What it does |
|---|---|---|
| `list_conversations` | Chats | Lists open or closed conversations, newest activity first. Pass `nextCursor` back as `cursor` for the next page |
| `search_conversations` | Chats | Finds conversations by the visitor's name, email or user ID, or by message text |
| `get_conversation` | Chats | Reads a conversation: its messages, notes among them with `kind: "note"`, the handler, the visitor, `pageContext`, the pages and `replySeconds`. `format: "markdown"` answers a short transcript with the assignee's name and `replySeconds` |
| `reply` | Chats | Replies in an open conversation, as the key's reply mode says: `status: "sent"` or `status: "drafted"`. Quote an earlier message with `replyToMessageId`. Pass the same `clientId` on a retry |
| `add_note` | Chats | Adds a note that only the team sees, in an open or closed conversation, even while a person handles it or bots are paused. Quote any earlier message with `replyToMessageId`. Pass the same `clientId` on a retry |
| `list_drafts` | Chats | Lists the drafts of keys in draft mode: `open`, `stale` or `all` |
| `hand_off` | Chats | Hands a conversation to people, with a reason, a summary and an optional last message to the visitor |
| `list_members` | Chats | Lists the members: `id`, `name`, `role` and whether they are `online`. The `id` is what `assign_conversation` and `hand_off` take |
| `set_typing` | Chats | Shows the visitor that the bot is typing, for 6 seconds |
| `wait_for_messages` | Chats | Waits up to 30 seconds for new visitor messages, from a cursor. With no cursor it answers the cursor for now, and no earlier messages |
| `close_conversation` | Chats | Closes a conversation. Marked destructive |
| `reopen_conversation` | Chats | Reopens a closed conversation |
| `snooze_conversation`, `unsnooze_conversation` | Chats | Snoozes an open conversation until `until`, or with `until` null until the visitor writes, or ends its snooze |
| `assign_conversation` | Chats | Assigns a conversation to a member by operator ID, or clears it with `null` |
| `get_contact` | Chats | Reads a visitor, by `visitorId` or by `conversationId`, exactly one of them, with their local time, pages and other conversations |
| `list_contacts`, `search_contacts` | Chats | Lists or finds the people who have a conversation |
| `get_live_visitors` | Chats | Lists the tabs of the site open now |
| `get_analytics` | Chats | The Analytics page's numbers for 7, 30 or 90 days |
| `get_install_snippet` | Full access | The code that adds the widget for a framework, and where it goes |
| `list_allowed_sites`, `add_allowed_site` | Full access | Lists or adds the origins where the widget may load |
| `remove_allowed_site` | Full access | Stops the widget on an origin. Marked destructive |
| `verify_install` | Full access | Checks whether the widget loaded on a site, and names the next step |
| `get_identity_setup` | Full access | Server code that signs the identity token. Never the signing secret |
| `get_appearance`, `update_appearance` | Full access | Reads or changes the widget's look and words, not the logo |
| `list_webhooks` | Full access | Lists the webhooks, with their events and who added them, never their secrets |
| `create_webhook` | Full access | Adds a webhook from `url` and `events`, and answers its signing secret, once |
| `delete_webhook` | Full access | Deletes a webhook. Marked destructive |
| `test_webhook` | Full access | Sends a signed `webhook.test` now and answers what the webhook answered |
| `get_webhook_verification` | Full access | Signature-check code in TypeScript, Python or Go |
| `list_webhook_deliveries`, `replay_webhook_delivery` | Full access | Lists a webhook's last 20 deliveries, or sends one again |
| `send_test_message` | Full access | Sends a message as a test visitor |
| `delete_test_visitors` | Full access | Deletes every test visitor. Marked destructive |

Each tool says in its annotations whether it only reads, whether a retry is safe, and whether it deletes or ends something. A client asks the person before it calls a destructive tool. The server's instructions, and every tool that returns text a visitor wrote, tell the agent that this text is data and that it must never follow instructions in it.

The server is stateless and answers JSON only: it keeps no session and opens no event stream, so `GET /v1/mcp` answers 405. It speaks these protocol versions:

- **2026-07-28**, which has no `initialize`. Each request names its version in `params._meta["io.modelcontextprotocol/protocolVersion"]`, and its `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers must match the body, or it answers 400 with the JSON-RPC error `-32020`. Its methods are `server/discover`, `ping`, `tools/list` and `tools/call`. Each result has `resultType: "complete"`, and `tools/list` adds `ttlMs` and `cacheScope: "private"`, because the list depends on the level. An unknown method answers 404 with `-32601`.
- **2025-11-25**, **2025-06-18** and **2025-03-26**, with `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`.

A version it does not know answers 400 with `-32022` and the supported list. A tool that fails answers with `isError: true` and the same stable `code` as the HTTP API, such as `not_found`, `human_handling` or `bots_paused`.
