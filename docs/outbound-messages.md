# Outbound messages

An outbound message is a message from your team to one visitor, which can exist before any conversation. Your server, your AI agent or a member of the team sends it, and the visitor sees it in the chat on your site. When the visitor answers, it becomes the first message of a conversation. When they never answer, it stays on their contact, and the inbox, alerts and analytics never see it.

Dinghy does not track what visitors do on your site. Your own code knows when something happened, such as a signup or a finished import, and it calls the API to send the message. It can also store facts about a person on their contact, such as `plan` or `domainVerified`, and a message can check them before it goes.

The examples use `https://chat.example.com` and `WORKSPACE_ID`. Put your own Dinghy address and workspace ID there. Code marked `// server` runs in your backend, and code marked `// page` runs in your site's pages.

## Set up a key

In **Settings > API & webhooks**, under **API keys**, create a key with **Send directly** and **May send as a member**. Keep its `dk_` token on your server.

- A key in **Drafts only** cannot send an outbound message. It answers 403 `send_mode_required`.
- **May send as a member** lets the key show a member's name and picture. The API calls it `permissions: ["send_as_member"]`. Without it, a `sender` that names a member answers 403 `send_as_member_required`.
- Both levels, **Chats** and **Full access**, can send.

A member of the team can send one too, from the operator app. See [Send one by hand](#send-one-by-hand).

## The server library

`@dinghy-chat/sdk` is a library for your backend, as `stripe` is for Stripe. It is MIT, has no dependencies and uses `fetch` and WebCrypto, so it runs on Node, Bun, Deno and Workers. Its types come from the API's OpenAPI file.

```sh
npm install @dinghy-chat/sdk
```

```ts
// server
import { Dinghy } from "@dinghy-chat/sdk";

const dinghy = new Dinghy({
  url: "https://chat.example.com",
  apiKey: process.env.DINGHY_API_KEY,
  signingSecret: process.env.DINGHY_SIGNING_SECRET, // optional, for identity.sign
  webhookSecret: process.env.DINGHY_WEBHOOK_SECRET, // optional, for webhooks.verify
});
```

| Call | What it does | HTTP |
|---|---|---|
| `dinghy.outboundMessages.send({ ... })` | Sends one outbound message | `POST .../outbound-messages` |
| `dinghy.outboundMessages.cancel({ visitor, once })` | Cancels the message that a `dedupeKey` names | `POST .../outbound-messages/cancel` |
| `dinghy.contacts.upsert({ ... })` | Creates or updates a contact by your user ID | `PUT .../contacts/by-user/{userId}` |
| `dinghy.events.stream({ types })` | An async iterator over the workspace's events | `GET /v1/events` |
| `dinghy.identity.sign(user)` | Signs the host token for `Dinghy.identify()` | None, it signs locally |
| `dinghy.webhooks.verify(request)` | Checks a webhook's signature and answers the typed event, or throws | None, it checks locally |

The library makes a `clientId` when you give none, and keeps it across its own retries. Each example on this page also shows the plain HTTP request, which works from any language. `...` stands for `/v1/operator/workspaces/WORKSPACE_ID`.

## Send one

```ts
// server
await dinghy.outboundMessages.send({
  visitor: { userId: "42", name: "Ada Lovelace", email: "ada@example.com" },
  body: "Your import finished. Want me to walk you through the results?",
});
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/outbound-messages \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "import-7781-done",
    "visitor": { "userId": "42", "name": "Ada Lovelace", "email": "ada@example.com" },
    "body": "Your import finished. Want me to walk you through the results?"
  }'
```

It answers 201 with `{ "outboundMessage": { ... } }`. A retry with the same `clientId` answers 200 with the first outbound message and creates nothing.

The body takes these fields:

| Field | Value |
|---|---|
| `clientId` | Required. Your own ID for this send, 1 to 64 letters, digits, `_` and `-` |
| `visitor` | Required. `{ "userId", "name"?, "email"?, "attributes"? }` creates or updates the visitor by your user ID, as the [contact upsert](#contacts) does. `{ "id" }` names a visitor that exists, by Dinghy's visitor ID |
| `body` | Required. Text with the same formatting and limit as a reply |
| `buttons` | Up to 4. See [Buttons](#buttons) |
| `sender` | Who the visitor sees. See [Who it comes from](#who-it-comes-from) |
| `assign` | Whether the visitor's answer assigns the conversation to the member sender. `true` by default when `sender` is a member |
| `startConversation` | `on_reply` (the default) or `now`. See [When it becomes a conversation](#when-it-becomes-a-conversation) |
| `show` | `badge` (the default), `preview` or `chat`. See [How it shows](#how-it-shows) |
| `ifConversationOpen` | `hold` (the default), `join` or `skip`. See [When a conversation is already open](#when-a-conversation-is-already-open) |
| `dedupeKey` | A dedupe key, unique per visitor, such as `welcome`. See [Send it once](#send-it-once) |
| `sendAt` or `delay` | A later time, such as `2026-11-16T09:00:00Z`, or a duration, such as `"1h"`. Not both. See [Send it later](#send-it-later) |
| `unless` | A condition on the contact. When it matches at the send time, the message is cancelled. See [Unless](#unless) |
| `expiresAt` | When it stops waiting. 30 days after it becomes `pending` by default. See [Expiry](#expiry) |
| `email` | `false` by default. See [Email](#email) |

The answer's `outboundMessage` has:

| Field | Value |
|---|---|
| `id`, `visitorId` | The outbound message and its visitor |
| `status`, `statusReason` | Where it stands, and why it waits or was cancelled. See [Its life](#its-life) |
| `body` | Its text. Null 30 days after it ended, and as soon as a member deletes its message or its conversation |
| `buttons` | Its buttons, as sent |
| `button` | The button the visitor chose, `{ value, label }`, or null. `value` is null for a button sent without one |
| `sender` | `"team"`, `{ operatorId, name }` for a member, or null for the key's own name |
| `author` | Who sent it: `{ kind, id, name, via }`, with `kind` `operator` or `key`, and `via` `mcp` for a send through MCP, else null |
| `show`, `ifConversationOpen`, `startConversation`, `assign`, `email`, `dedupeKey` | As sent, with their defaults |
| `conversationId`, `messageId` | The conversation and the message it became, or null before that |
| `sendAt`, `expiresAt` | When it goes out, and when it stops waiting. `expiresAt` is null until it becomes `pending`, unless you set it |
| `deliveredAt`, `readAt`, `repliedAt`, `dismissedAt`, `cancelledAt` | When each happened, or null |
| `createdAt` | When Dinghy took the send |

## When it becomes a conversation

`startConversation` decides.

- `on_reply`, the default: the message waits on the contact. The widget shows it, and when the visitor answers, Dinghy puts it in a conversation, then their answer. When nobody answers, the inbox, alerts, analytics and the `message.created` webhook never see it.
- `now`: Dinghy puts it in a conversation as soon as it becomes `pending`. The answer's `conversationId` is set. The conversation is open, and it does not count as waiting for the team. The visitor sees it on their next visit, or by email with `email: true`.

A message goes in the visitor's open conversation, or in their newest closed one, which it reopens, or in a new one. A conversation that an outbound message started has `startedBy: "team"`. In the inbox it sits under the **Started by the team** filter until the visitor answers. Analytics counts it in `startedByTeam`, and its first reply time starts at the visitor's first message.

When the visitor answers, every outbound message the widget showed and they read goes in first, in the order they read them, then their answer. A second tab or a retry adds nothing twice.

## When a conversation is already open

`ifConversationOpen` decides what happens when the visitor has an open conversation at the moment the message would show.

- `hold`, the default: it waits until that conversation closes, with `statusReason: "open_conversation"`.
- `join`: it goes in that conversation at once.
- `skip`: it is cancelled, with `statusReason: "open_conversation_skipped"`.

A person's handling comes first. While a person handles the open conversation, a message from a key never joins it: `join` waits as `hold` does, with `statusReason: "human_handling"`. A message that a member sends by hand joins.

## How it shows

`show` decides how the widget presents a message that waits for the visitor.

- `badge`, the default: the launcher pulses and the unread count goes up. The message is in the chat when the visitor opens it.
- `preview`: a card above the launcher, with the sender's face, the first lines, its buttons and a close button. A click opens the chat. The widget shows one card at a time, the newest, and counts the others in the badge. Closing the card only hides it. The message stays in the chat.
- `chat`: the widget opens the chat.

The widget protects the visitor:

- With `prefers-reduced-motion`, the badge stays still and the card does not slide.
- `chat` acts as `preview` on a phone, after the visitor closed the chat on this page, and while an input of your page has focus.
- A message that arrives while the visitor types never moves the message box or takes the focus.

With `data-launcher="hidden"` and your own button, `badge` raises the unread count, and `preview` shows its card in the configured corner, with the same offsets. Your page can pulse its own button and draw its own card from the widget's events. See [Outbound messages](add-to-your-site.md#outbound-messages) in Add the chat to your website.

## Who it comes from

`sender` decides who the visitor sees.

- `{ "operatorId": "..." }` or `{ "email": "julien@example.com" }`: a member of the team, with their name and picture. A key needs **May send as a member**. `email` is the member's sign-in email, and `operatorId` comes from `GET .../members` or the MCP `list_members` tool. A sender who is not a member answers 400 `invalid_request`.
- `"team"`: the workspace's name and logo.
- Left out: the key's name, as on the key's replies, or the member who sends it by hand.

When the visitor answers a message sent as a member, the conversation is assigned to that member, and a person handles it from then on, so a bot's next reply cannot change the name in the middle of the chat. `assign: false` turns this off.

In the operator app, the message shows "Julien, via Welcome bot" and an **Automatic** tag. The visitor sees only Julien.

## Its life

```text
            sendAt reached, checks pass
 scheduled ----------------------------> pending --(widget fetched it)--> delivered --(seen in the chat)--> read --(visitor answers)--> replied
                                                                                                             |
                                                                                                             +--(dismiss button)--> dismissed
 Before it is read: a cancel or `unless` ends it as cancelled, and expiresAt ends it as expired.
```

| `status` | Meaning |
|---|---|
| `scheduled` | It waits for `sendAt`. Nothing reaches a conversation, an email or the widget, whatever `startConversation` says |
| `pending` | It waits for the widget to fetch it |
| `delivered` | The widget fetched it and showed it |
| `read` | The visitor saw it in the open chat, or chose one of its buttons on a card |
| `replied` | The visitor answered, in the chat or with a button |
| `dismissed` | The visitor chose a dismiss button |
| `cancelled` | A cancel, `unless` or a check ended it before it was read. `statusReason` says which |
| `expired` | `expiresAt` passed before the visitor read it |

At the send time, Dinghy checks the message again: a blocked visitor, the key's permissions, the workspace's access, paused bots and `unless`. It checks the open conversation when the message would join it: at once with `startConversation: "now"`, and when the widget fetches it with `on_reply`. A check that can change makes the message wait: it keeps its status, `statusReason` says why, and Dinghy checks it again about once a minute. A check that holds for good cancels it. The widget's fetch checks it again too.

`statusReason` is null when nothing holds the message. Part of the list is for campaigns, which come in a later release, so a client can switch on every value from the start. Dinghy sets these now:

| `statusReason` | Waits or cancels | Why |
|---|---|---|
| `open_conversation` | Waits | `ifConversationOpen: "hold"`, and the visitor has an open conversation |
| `open_conversation_skipped` | Cancels | `ifConversationOpen: "skip"`, and the visitor has an open conversation |
| `human_handling` | Waits | A person handles the open conversation, so a key's message does not join it |
| `bots_paused` | Waits | An owner or admin paused every bot, and the key's message waits for the resume |
| `blocked` | Cancels | The team blocked the visitor |
| `permission_revoked` | Waits or cancels | It cancels when the key was revoked or the member sender left the team. It waits when the key lost **May send as a member** or **May email visitors**, or went back to **Drafts only** |
| `workspace_inactive` | Waits | The workspace is read-only or suspended |
| `unless_matched` | Cancels | `unless` matched the contact |
| `cancelled_by_request` | Cancels | A cancel through the API, MCP or the operator app |
| `conversation_deleted` | Cancels | A member deleted the conversation it was in before the visitor answered. Its text goes with it |

Campaigns will set `audience_unmatched`, `frequency_capped`, `goal_reached`, `outside_business_hours`, `campaign_paused`, `campaign_ended` and `opted_out`. Dinghy does not set them yet.

The contact page in the operator app lists the person's outbound messages with their status and reason, such as "read 10:02, not answered" or "waiting: open conversation".

## Send it once

`dedupeKey` is a dedupe key for your own logic, such as `welcome` or `dns-unverified:7781`, up to 200 characters. It is unique per visitor. The first send with it answers 201, and every later send with it answers 200 with the first outbound message, whatever became of it, so your signup handler can send `welcome` on every login.

A cancel frees the key, so the next send with it creates a new message. An expiry does not free it.

`dedupeKey` is not `clientId`. `clientId` makes a retry of the same request safe. `dedupeKey` stops a second message for the same reason, from any request.

## Send it later

`delay` holds the message for a duration: a number from 1 to 9999 with `m`, `h` or `d`, such as `"30m"`, `"1h"` or `"7d"`. `sendAt` holds it until a time. A time in the past sends now. A send with both answers 400 `invalid_request`.

Until then the message is `scheduled`, and the worker sends it at that time. You need no cron of your own.

## Unless

`unless` is a condition on the contact's fields. Dinghy checks it when the message is about to go: at `sendAt`, or at once with no delay. When it matches, the message is cancelled with `statusReason: "unless_matched"`. A change to the contact before then, through the [contact upsert](#contacts) or a host token, checks it again at once.

```json
{ "all": [
  { "field": "attributes.plan", "op": "in", "value": ["trial", "pro"] },
  { "field": "attributes.domainVerified", "op": "ne", "value": true },
  { "any": [
    { "field": "country", "op": "eq", "value": "FR" },
    { "field": "language", "op": "eq", "value": "fr" }
  ]}
]}
```

A condition is a rule, `{ field, op, value }`, or a group, `{ all: [...] }`, `{ any: [...] }` or `{ not: ... }`, and groups nest. One condition holds at most 50 rules and groups. The contacts list takes the same grammar as its `filter`.

| Field | Kind | Value |
|---|---|---|
| `name`, `email`, `userId` | Text | The contact's name, email and your user ID |
| `firstName` | Text | The first word of `name` |
| `language` | Text | The widget's language, `en`, `fr` or `es` |
| `country`, `timeZone` | Text | From the widget's beat, such as `FR` and `Europe/Paris` |
| `signedIn` | Boolean | True when the contact has a `userId` |
| `hasChatted` | Boolean | True when the contact has a conversation |
| `conversationCount` | Number | How many conversations they have |
| `firstSeenAt`, `lastSeenAt` | Time | When they first came, and when they were last seen |
| `attributes.<key>` | Any | One of the contact's attributes, such as `attributes.plan` |

| Kind | `op` |
|---|---|
| Text | `eq`, `ne`, `in`, `not_in`, `exists`, `missing`, `contains` |
| Boolean | `eq`, `ne`, `exists`, `missing` |
| Number | `eq`, `ne`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte` |
| Time | `exists`, `missing`, `gt`, `gte`, `lt`, `lte`, `older_than` |
| Attribute | `eq`, `ne`, `in`, `not_in`, `exists`, `missing`, `gt`, `gte`, `lt`, `lte`, `contains` |

- `in` and `not_in` take a list. `exists` and `missing` take no value. The others take one value.
- A time takes a value such as `2026-11-15T09:00:00Z`. `older_than` takes a duration: `{ "field": "lastSeenAt", "op": "older_than", "value": "7d" }`.
- `contains` matches text, ignoring case, and an attribute that holds a list matches when the list holds the value.
- `ne` and `not_in` match a missing value, so `{ "field": "attributes.domainVerified", "op": "ne", "value": true }` matches a contact with no such attribute.
- A comparison on an attribute reads only a value of the same type: `gt` with a number matches only a number.

A condition that names an unknown field, or an `op` its field does not take, answers 400 `invalid_request`.

## Expiry

A message that the visitor has not read ends as `expired` at `expiresAt`, which is 30 days after it becomes `pending`, unless you set it. An `expiresAt` that is not after the send time answers 400 `invalid_request`. A message that the visitor read stays in their chat, and one already in a conversation never expires.

## Email

`email` is `false` by default. With `true`, `startConversation: "now"` and a visitor with an email, the reply email carries the message, with its usual link to stop these emails. A key needs **May email visitors** to send with `true`, or the send answers 403 `send_email_required`, because a key that sets the contact's email chooses where the email goes. A member who sends by hand needs no permission. With `false`, the reply email leaves it out, even when a member's later reply goes out by email. A message left out of an email never shows an email receipt.

## Buttons

A message can carry up to 4 buttons, each in one of three shapes, with a `label` of up to 40 characters:

| Shape | What a click does |
|---|---|
| `{ "label": "Yes, please", "value": "yes" }` | Answers with the label. The visitor's message carries `button: { value, label }`, so a bot reads the value, not a label in some language |
| `{ "label": "Read the guide", "url": "https://example.com/guide" }` | Opens the page. `url` is `http` or `https` |
| `{ "label": "I'm fine", "dismiss": true }` | Ends the message as `dismissed`, and opens no conversation |

The last two take an optional `value` too, up to 100 characters. A card shows the buttons, so a click there records the read first. The chosen button is on the outbound message's `button`, and on the `replied` and `dismissed` events.

A message that goes in a conversation before the visitor answers, with `startConversation: "now"` or `ifConversationOpen: "join"`, keeps its buttons there. The chat shows them under the message until the visitor writes after it or dismisses it, and the widget API's messages carry them as `buttons`.

## Cancel

```ts
// server
await dinghy.outboundMessages.cancel({ visitor: { userId: "42" }, dedupeKey: "welcome" });
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/outbound-messages/cancel \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "visitor": { "userId": "42" }, "once": "welcome" }'
```

`visitor` is `{ "userId" }` or `{ "id" }`, and a cancel creates nobody. `POST .../outbound-messages/{id}/cancel` cancels one by its ID.

A cancel ends only a message that the visitor has not read and that is in no conversation: `scheduled`, `pending` or `delivered`. It ends as `cancelled`, with `statusReason: "cancelled_by_request"`, and its `dedupeKey` is free again. A message already read, answered or ended stays as it is. Either way the answer is `{ outboundMessage }` as it is now, so read its `status`. With no message for that `dedupeKey`, `outboundMessage` is null. With no message of that ID, the route answers 404.

## List and read

`GET .../outbound-messages` lists them, newest first. It takes `visitorId`, `status` and `apiKeyId` as filters, and `limit`, 1 to 100, 50 by default. It answers `{ outboundMessages, next }`. Pass `next` as `cursor` for the next page. `GET .../outbound-messages/{id}` reads one.

## Limits and errors

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | The body does not match the schema, the sender is not a member, `sendAt` and `delay` both came, or `expiresAt` is not after the send time |
| 403 | `send_mode_required` | The key drafts replies. Set it to **Send directly** in **Settings > API & webhooks** |
| 403 | `send_as_member_required` | The key may not send as a member. Turn on **May send as a member** |
| 403 | `blocked` | The team blocked this visitor |
| 404 | `not_found` | No visitor has this `id` |
| 409 | `bots_paused` | An owner or admin paused every bot. A message with a later send time waits for the resume instead |
| 429 | `too_many_waiting` | The visitor has 5 outbound messages that wait, in no conversation yet. Cancel one, or wait for them to end |
| 429 | `too_many_requests` | The key sent more than 60 outbound messages in a minute, or made more than 300 requests in a minute. Wait for the `Retry-After` header's seconds |

A member who sends by hand is never refused with `bots_paused` or `send_mode_required`.

## Contacts

Your server can create a contact, or set facts about one, before any chat. Attributes merge key by key, and a `null` value removes a key.

```ts
// server
await dinghy.contacts.upsert({
  userId: "42",
  name: "Ada Lovelace",
  email: "ada@example.com",
  attributes: { plan: "pro", domainVerified: false },
});
```

```sh
# server
curl -X PUT https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/contacts/by-user/42 \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Ada Lovelace", "email": "ada@example.com", "attributes": { "plan": "pro", "domainVerified": false } }'
```

It answers 201 with the new contact, or 200 with the contact after the change. Each write carries its time, and the later write wins for each field and each attribute. A host token's write counts at its `iat`, so a token signed before your upsert does not undo it. A change cancels the person's scheduled messages whose `unless` now matches.

A send's `visitor` takes the same fields, so one call can create the contact and send the message. Contacts with no conversation are hidden in the operator app's **Contacts** until you turn off **Has chatted**. The API has the [details](api.md#outbound-messages-and-contacts).

## Webhooks and events

Each change of an outbound message is an event, for [webhooks](api.md#webhooks) and [`GET /v1/events`](api.md#events-for-api-keys). Its `data` is `{ outboundMessage }`, with the shape above.

| Event | When |
|---|---|
| `outbound_message.sent` | It reached its send time and waits for the widget |
| `outbound_message.delivered` | The widget fetched it |
| `outbound_message.read` | The visitor read it |
| `outbound_message.replied` | The visitor answered it. `button` says which button, if any |
| `outbound_message.dismissed` | The visitor chose a dismiss button |
| `outbound_message.cancelled` | It was cancelled. `statusReason` says why |
| `outbound_message.expired` | `expiresAt` passed before the visitor read it |

```ts
// server
for await (const event of dinghy.events.stream({ types: ["outbound_message.replied"] })) {
  await onReply(event);
}
```

```sh
# server
curl -N "https://chat.example.com/v1/events?types=outbound_message.replied" \
  -H "Authorization: Bearer dk_..."
```

To check a webhook in your server, `dinghy.webhooks.verify(request)` answers the typed event, or throws when the signature is wrong. [Webhooks](api.md#webhooks) has the same check in TypeScript, Python and Go.

Delivery is at least once, so the same event can come twice. Drop an event ID you have seen.

## In the widget

The widget fetches the visitor's waiting messages when the page loads, when `Dinghy.identify()` sets a new user, on its beat each minute, and over its stream while the chat is open. A page with nothing waiting downloads nothing more than it does today.

The widget finds a signed-in user by your user ID, so a message sent to `{ "userId": "42" }` reaches user 42 on every device once your page calls `Dinghy.identify()`. A visitor who is not signed in can get one only by their visitor ID, `{ "id" }`, which `Dinghy.state.visitorId` gives your page.

Your page can follow outbound messages and pulse its own button. [Add the chat to your website](add-to-your-site.md#outbound-messages) lists `Dinghy.nudge()`, `Dinghy.state.visitorId`, `Dinghy.state.nudging` and the `visitor`, `nudge`, `message:received`, `outbound:read` and `outbound:dismissed` events.

## Send one by hand

A member can send an outbound message from the operator app, with **Message** on a contact's page and next to a visitor in **Visitors**. It is the same route, with the member's session, so you can reach someone on your site now. It shows as the member who sends it, and joins an open conversation.

## With MCP

An AI agent has four tools for every key, Chats and Full access alike:

- `send_outbound_message` sends one, with the same fields as the route. Its `clientId` is required.
- `cancel_outbound_message` cancels one by `outboundMessageId`, or by `visitor` and `dedupeKey`.
- `list_outbound_messages` lists them, with their `status` and `statusReason`.
- `upsert_contact` creates or updates a contact by `userId`.

[Use Dinghy with AI agents](agents.md#send-outbound-messages) has more.

## Recipes

### A welcome, only if the user opens the chat

After signup, the launcher pulses. When the user opens the chat, a welcome from Julien is there. When they never open it, no conversation exists. It happens once.

```ts
// server, in the signup handler
await dinghy.outboundMessages.send({
  visitor: { userId: user.id, name: user.name, email: user.email },
  sender: { email: "julien@example.com" },
  body: "Welcome! Stuck on DNS or an import? Ask me here.",
  dedupeKey: "welcome",
});
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/outbound-messages \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "welcome-42",
    "visitor": { "userId": "42", "name": "Ada Lovelace", "email": "ada@example.com" },
    "sender": { "email": "julien@example.com" },
    "body": "Welcome! Stuck on DNS or an import? Ask me here.",
    "once": "welcome"
  }'
```

The page already calls `Dinghy.identify()`, and it needs no other change. `GET .../outbound-messages?status=replied` counts the answers.

### Domain not verified after an hour

An hour after a domain is added, if it is still not verified, offer help. With no cron:

```ts
// server, when the domain is added
await dinghy.outboundMessages.send({
  visitor: { userId: owner.id },
  body: `${domain.name} is not verified yet. Want me to check your DNS with you?`,
  delay: "1h",
  dedupeKey: `dns-unverified:${domain.id}`,
});

// server, when the domain verifies
await dinghy.outboundMessages.cancel({
  visitor: { userId: owner.id },
  dedupeKey: `dns-unverified:${domain.id}`,
});
```

```sh
# server, when the domain is added
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/outbound-messages \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "dns-unverified-7781",
    "visitor": { "userId": "42" },
    "body": "example.com is not verified yet. Want me to check your DNS with you?",
    "delay": "1h",
    "once": "dns-unverified:7781"
  }'

# server, when the domain verifies
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/outbound-messages/cancel \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "visitor": { "userId": "42" }, "once": "dns-unverified:7781" }'
```

A cancel after the visitor read the message changes nothing, and its answer says so in `status`. To skip the cancel call, store the fact on the contact instead and send with `unless`:

```ts
// server, when the domain is added
await dinghy.outboundMessages.send({
  visitor: { userId: owner.id },
  body: `${domain.name} is not verified yet. Want me to check your DNS with you?`,
  delay: "1h",
  dedupeKey: `dns-unverified:${domain.id}`,
  unless: { field: `attributes.domainVerified_${domain.id}`, op: "eq", value: true },
});

// server, when the domain verifies
await dinghy.contacts.upsert({
  userId: owner.id,
  attributes: { [`domainVerified_${domain.id}`]: true },
});
```

### An AI agent through MCP

When an import ends, the agent tells the user in a conversation that starts now:

```json
{
  "name": "send_outbound_message",
  "arguments": {
    "clientId": "import-7781-done",
    "visitor": { "userId": "42" },
    "body": "Your import finished with 3 skipped messages. Want the list?",
    "startConversation": "now",
    "once": "import-7781-done"
  }
}
```

The answer's `outboundMessage.conversationId` is set, and `wait_for_messages` picks up the user's answer.
