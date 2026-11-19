# Campaigns

A campaign is a saved rule that sends [outbound messages](outbound-messages.md): who gets one, when, what it says, how it shows and how often. Support writes it in the operator app, or your code keeps it in your repository and applies it with the API. Each message a campaign makes is an outbound message, with the same statuses, webhooks and widget behavior, and the campaign counts its results per day.

A campaign is one JSON object. The operator app's editor, the API, MCP and `@dinghy-chat/sdk` all take the same shape, and **Copy as code** in the editor gives it back.

The examples use `https://chat.example.com` and `WORKSPACE_ID`. Put your own Dinghy address and workspace ID there. Code marked `// server` runs in your backend. `...` stands for `/v1/operator/workspaces/WORKSPACE_ID`.

## A campaign

```json
{
  "key": "dns-help",
  "name": "DNS help after signup",
  "audience": { "all": [
    { "field": "attributes.plan", "op": "in", "value": ["trial", "pro"] },
    { "field": "attributes.domainVerified", "op": "ne", "value": true }
  ]},
  "trigger": { "type": "match", "delay": "1h" },
  "message": {
    "sender": { "email": "julien@example.com" },
    "body": "Hi {{ firstName | default: \"there\" }}, your domain is not verified yet. Want me to check your DNS with you?",
    "buttons": [
      { "label": "Yes, please", "value": "yes" },
      { "label": "I'm fine", "dismiss": true, "value": "no" }
    ],
    "translations": {
      "fr": {
        "body": "Bonjour{{ firstName | prepend: \" \" }}, votre domaine n'est pas encore vérifié. Voulez-vous que je vérifie vos DNS avec vous ?",
        "buttons": [
          { "label": "Oui, merci", "value": "yes" },
          { "label": "Ça va", "dismiss": true, "value": "no" }
        ]
      }
    }
  },
  "presentation": { "startConversation": "on_reply", "show": "preview", "ifConversationOpen": "skip" },
  "delivery": { "sendEmail": false, "expiresIn": "30d" },
  "rules": {
    "frequency": "once",
    "businessHours": true,
    "endsAt": null,
    "exitWhen": { "field": "repliedToCampaign", "op": "eq", "value": true },
    "goal": { "field": "attributes.domainVerified", "op": "eq", "value": true, "within": "7d" }
  }
}
```

| Part | Required | What it holds |
|---|---|---|
| `key` | Yes | Your name for it in code: 1 to 64 lowercase letters, digits, `-` and `_`, starting with a letter or a digit, unique in the workspace |
| `name` | Yes | The name the team reads, 1 to 100 characters |
| `audience` | No | Who it is for: a [condition](outbound-messages.md#unless) on the contact. Left out, everyone |
| `trigger` | Yes | When a contact gets it. See [Triggers](#triggers) |
| `message` | Yes | What it says. See [Message](#message) |
| `presentation` | Yes | `startConversation`, `show` and `ifConversationOpen`. See [Presentation](#presentation) |
| `delivery` | No | `sendEmail`, `assignOnReply`, `expiresIn` and `emailIfUnread`. See [Delivery](#delivery) |
| `rules` | No | `frequency`, `businessHours`, `sendWindow`, `endsAt`, `exitWhen` and `goal`. See [Rules](#rules) |
| `variants` | No | A/B variants and a control group. See [Variants](#variants-and-the-control-group) |

A duration, such as `delay` or `expiresIn`, is a number from 1 to 9999 with `m`, `h` or `d`, such as `"30m"`, `"1h"` or `"7d"`. The campaign keeps it as you wrote it.

A definition whose parts do not fit together answers 400 `invalid_request`, with one line for each problem, such as an unknown variable in the text.

## Status

The object holds no status. A new campaign is a `draft`, and only three actions change its status:

| Action | From | To | What it does |
|---|---|---|---|
| `resume` | `draft`, `paused` | `live` | Starts it. Its messages that waited for the pause go on |
| `pause` | `live` | `paused` | It makes no new messages, and its messages not sent yet wait, with `statusReason: "campaign_paused"` |
| `end` | `draft`, `live`, `paused` | `ended` | Ends it for good. Its messages that wait for the visitor are cancelled with `campaign_ended` |

A save never changes the status, so a deploy that upserts its campaigns never resumes one that support paused. A save of a live campaign applies to its new messages only. An action from a status it does not start from changes nothing and answers the campaign as it is. An ended campaign does not change again: a save or an action answers 409 `campaign_ended`. Its key stays taken, so make a new one with another key.

When `rules.endsAt` passes, the worker ends the campaign within about a minute.

A campaign that never sent a message, such as a draft or a trial run, can be deleted with `DELETE .../campaigns/{id}`. Test messages do not count, and they go with it. A live one answers 409 `campaign_live`, so pause or end it first. One that sent answers 409 `campaign_sent`: it keeps its results, so end it instead.

## Triggers

`trigger.type` decides when a contact gets the message.

| `type` | Fields | When |
|---|---|---|
| `match` | `delay`, optional | When a contact starts to match the audience, after `delay` |
| `schedule` | `repeat`, `time`, `days`, `startDate`, `endDate`, `timeZone` | Everyone in the audience, at a time of day, once or again |
| `event` | `name`, `delay` optional | When your server [tracks](#server-events) the event `name` for a contact in the audience, after `delay` |
| `page` | `url`, `seconds` | In the widget, after `seconds` on a page that matches `url` |
| `api` | None | Only when your code calls [send](#send-from-your-code) |

### match

Dinghy checks a contact against a `match` campaign when a field its audience reads changes: through the [contact upsert](outbound-messages.md#contacts), a send's `visitor`, a host token, a [tracked event](#server-events), or the visitor's message in the chat. A new contact is checked against every live campaign. Each campaign is indexed by the fields it reads, so a change checks only the campaigns that read a changed field, for that one contact.

A contact who already matched when the campaign went live gets the message at their next change, not at once. To reach everyone who matches now, use a `schedule` with `repeat: "once"`.

An audience that changes with time alone, with `older_than`, such as "last seen more than 7 days ago", is checked on the widget's beat each minute while the visitor has a page open, which is when an on-site message can show anyway. A `match` campaign with such an audience and `delivery.sendEmail: true` also gets a daily pass over the contacts who have an email address, in batches.

With `delay`, the message is `scheduled` until then. At its send time, Dinghy checks the whole audience and the rules again.

### schedule

```json
{ "type": "schedule", "repeat": "weekly", "days": ["mon", "thu"], "time": "09:00", "startDate": "2026-12-01", "endDate": "2027-03-01", "timeZone": "Europe/Paris" }
```

| Field | Value |
|---|---|
| `repeat` | `once`, `daily`, `weekly` or `monthly` |
| `time` | The time of day, such as `09:00` |
| `days` | For `weekly` only, and required there: `mon` to `sun` |
| `startDate` | The first day, such as `2026-12-01`. `once` runs on it, and `monthly` runs on its day of the month |
| `endDate` | Optional. The last day it runs |
| `timeZone` | An IANA time zone for `time` and the dates. `UTC` by default |

Each time comes, the worker starts a run over the audience. A run goes through the contacts in batches of 50, and each batch commits its messages with its place in the list. A contact gets at most one message per run, so a crash or a restart resumes the run with no double and no gap. A run leaves out test visitors and blocked visitors. A paused campaign's run waits, as do the runs of a workspace that paused every campaign, and goes on from where it stopped after the resume. A time that came before the campaign went live, or while it was paused, is skipped.

### event

```json
{ "type": "event", "name": "export.finished", "delay": "10m" }
```

When your server tracks `export.finished` for a contact who matches the audience, the contact gets the message. The event's `properties` fill `{{ event.properties.<key> }}` in the text. A repeat of an event `id` that was counted already runs nothing.

### page

```json
{ "type": "page", "url": "/pricing*", "seconds": 20 }
```

`url` is a path or a full URL, up to 500 characters, where `*` matches any text. A path matches on any of your allowed sites. `seconds` is 0 to 3600.

A page campaign runs in the visitor's browser. The loader's beat answers the live page campaigns for this visitor, and the loader matches the page's address. After `seconds` on a matching page, the widget shows the message as its `show` says. It shows each page campaign at most once per page load, and in a single-page app once per tab. It shows only when a message of the campaign could be sent now: the [send-time checks](#when-a-message-goes) apply, such as business hours, `exitWhen`, the workspace's gap and an open conversation with `ifConversationOpen: "skip"`. A visitor who has never chatted sees only a campaign with no audience and no variants. The server stores nothing about the visitor until they answer. A show counts in `entered`, `sent` and `delivered`, a read in `read`, and a press of a button that opens a page or dismisses in `clicks` by its value, and a dismiss in `dismissed` too. When the visitor answers, the campaign's message goes in the conversation first, then their answer. [Add the chat to your website](add-to-your-site.md#page-campaigns) says what the browser keeps.

A page campaign shows as `badge` or `preview`, never `chat`, and starts a conversation `on_reply`. A definition with another choice answers 400 `invalid_request`.

### api

An `api` campaign makes a message only when your code [sends it](#send-from-your-code) for one person. It skips the audience, because your code chose the person.

## Message

| Field | Value |
|---|---|
| `sender` | Who the visitor sees: `{ "email" }` or `{ "operatorId" }` for a member, `"team"` for the workspace, or left out for whoever saved the campaign last. See [Who it comes from](outbound-messages.md#who-it-comes-from) |
| `body` | The text, with the same formatting and limit as a reply, and [variables](#variables) |
| `buttons` | Up to 4, each with a `value`. See [Buttons](outbound-messages.md#buttons) |
| `translations` | A `body` and `buttons` per language, `en`, `fr` or `es` |

Each button of a campaign has a `value`, a dismiss button and a link too, so results count clicks by a value that does not change with the language.

A visitor whose widget language has a translation gets it. Every other visitor gets `body`. A translation with no `buttons` uses the message's own.

A campaign's messages come from the member or key that saved it last. That member or key must be allowed to send them: a key in **Drafts only** answers 403 `send_mode_required` on the save, a member `sender` needs **May send as a member**, and `sendEmail` or `emailIfUnread` needs **May email visitors**.

### Variables

The text takes variables in double braces, such as `{{ firstName }}`, with optional filters after a `|`:

```text
Hi {{ firstName | default: "there" }}, your {{ attributes.plan | upcase }} trial ends soon.
```

| Variable | Value |
|---|---|
| `name`, `firstName`, `email`, `userId` | The contact's fields. `firstName` is the first word of `name` |
| `language`, `country`, `timeZone` | The widget's language, and the country and time zone from the beat |
| `attributes.<key>` | One of the contact's attributes |
| `data.<key>` | For an `api` campaign: the `data` of the send |
| `event.properties.<key>` | For an `event` campaign: the tracked event's `properties` |

| Filter | What it does |
|---|---|
| `default: "text"` | The text when the value is empty |
| `prepend: "text"` | Adds the text before a value. An empty value stays empty |
| `append: "text"` | Adds the text after a value. An empty value stays empty |
| `upcase`, `downcase` | Capitals or small letters |

A missing value, or one that is not text, a number or a yes or no, is empty. Since `prepend` keeps an empty value empty, `Bonjour{{ firstName | prepend: " " }},` reads "Bonjour," for a contact with no name. A variable that the trigger does not give, such as `data.plan` in a `match` campaign, answers 400 `invalid_request` when you save.

## Presentation

`startConversation`, `show` and `ifConversationOpen` work as on any outbound message: [When it becomes a conversation](outbound-messages.md#when-it-becomes-a-conversation), [How it shows](outbound-messages.md#how-it-shows) and [When a conversation is already open](outbound-messages.md#when-a-conversation-is-already-open). A campaign has no defaults for them, so **Copy as code** always shows all three.

## Delivery

| Field | Value |
|---|---|
| `sendEmail` | As on an outbound message. `false` by default. See [Email](outbound-messages.md#email) |
| `assignOnReply` | As on an outbound message. `true` by default with a member sender |
| `expiresIn` | How long each message waits for the visitor after its send time, such as `"7d"`. 30 days after it is sent by default |
| `emailIfUnread` | A duration. An `on_reply` message still unread that long after it is sent goes in a conversation, and out by email to a visitor with an email address |

With `emailIfUnread`, the on-site message comes first, and the email only reaches someone who did not see it. A visitor with no email address keeps the message on the site.

## Rules

| Field | Value |
|---|---|
| `frequency` | `"once"`, the default: one message per contact, ever. `{ "every": "7d" }`: at most one per contact in that time |
| `businessHours` | `true` sends only during the workspace's [business hours](api.md#business-hours), when they are on. `false` by default |
| `sendWindow` | `{ "from": "09:00", "to": "18:00" }` sends only between these times on the visitor's own clock. It may cross midnight. For a visitor whose time zone Dinghy does not know, it reads the business hours' time zone when `businessHours` is on, and UTC otherwise |
| `endsAt` | A time when the campaign ends, or `null`, the default |
| `exitWhen` | A condition. A contact who matches it leaves the campaign, and their waiting messages from it are cancelled |
| `goal` | A condition, plus `within`, a duration. See below |

A cancelled message does not count for `frequency`, but a place in the control group does.

A message outside the business hours or the send window waits, with `statusReason` `outside_business_hours` or `outside_send_window`, until they open again.

`exitWhen` and `goal` take the [condition grammar](outbound-messages.md#unless), plus a field of their own, `repliedToCampaign`: true when the contact answered one of this campaign's messages. `{ "field": "repliedToCampaign", "op": "eq", "value": true }` stops the campaign for a contact once they answer. A contact who exits has their waiting messages cancelled with `unless_matched`.

`goal` is what the campaign is for, such as a verified domain. When a contact matches it within `within` after one of the campaign's messages became sent to them, or for the control group after the time it would have, the message counts `goalReached`, the contact's waiting messages from the campaign are cancelled with `goal_reached`, and the contact never enters the campaign again. Dinghy checks it when a field it reads changes, as for a `match` trigger, and before `exitWhen`, so a change that matches both still counts the goal.

## Variants and the control group

```json
"variants": [
  { "key": "short", "weight": 45, "message": { "body": "Domain not verified yet. Want help?" } },
  { "key": "long", "weight": 45 },
  { "key": "control", "weight": 10, "control": true }
]
```

`variants` holds 2 to 5 variants, each with its own `key` and a `weight` from 1 to 100. A variant with a `message` sends it, and one without sends the campaign's own. At most one variant has `control: true`: its contacts get nothing, so the goal's results can compare those who got a message with those who did not.

Each contact gets a variant by weight, and always the same one for the same campaign. A contact in the control group counts in `entered` and for `frequency`, as if a message reached them, and has an outbound message with `status: "cancelled"`, `statusReason: "control_group"` and no text.

## When a message goes

A campaign's message is an outbound message, and the checks of [Its life](outbound-messages.md#its-life) apply to it. When it is about to become `sent`, Dinghy also checks the campaign:

| Check | Then |
|---|---|
| The campaign ended | Cancelled, `campaign_ended` |
| The contact matches `exitWhen` | Cancelled, `unless_matched` |
| The contact reached the goal | Cancelled, `goal_reached` |
| The contact no longer matches the audience, for every trigger but `api` | Cancelled, `audience_unmatched` |
| The campaign is paused, or every campaign is | Waits, `campaign_paused` |
| Outside the business hours or the send window | Waits, `outside_business_hours` or `outside_send_window` |
| Another campaign message reached the visitor within the workspace's gap | Cancelled, `frequency_capped` |

A campaign's message does not wait for paused bots: it has its own pause. It still never joins a conversation that a person handles, as a key's message does not. A test visitor gets a campaign's message whatever these checks say.

## Rules for every campaign

`GET .../campaign-settings` answers `{ paused, gapHours, pausedBy, pausedAt }`, where `pausedBy` is the name of the member or key who paused every campaign, and owners, admins and Full access keys change them with `PUT` and both fields. In the operator app they are on the Campaigns page.

- `paused: true` is **Pause all campaigns**: every campaign's messages wait, with `campaign_paused`, until it is `false` again. It is apart from pausing the bots.
- `gapHours` is the fewest hours between two campaign messages to one visitor, from 0 to 720, 24 by default. 0 turns it off. Dinghy checks it when a campaign's message becomes `sent`, under the workspace's lock, so two campaigns cannot both pass. A message that comes too soon after another is cancelled with `frequency_capped`. It counts messages from every campaign, `api` ones too, and never outbound messages sent without a campaign.

## Results

`GET .../campaigns/{id}/results` answers the campaign's results per day in UTC and per variant, and `from` and `to`, such as `2026-12-01`, choose the days. Each campaign also answers `totals`, its results since it started, all variants together.

```json
{
  "days": [
    { "day": "2026-12-01", "variant": null, "entered": 120, "sent": 118, "delivered": 64, "read": 41, "replied": 12, "dismissed": 9, "goalReached": 30, "conversationsStarted": 12, "clicks": { "yes": 10, "no": 9 } }
  ],
  "variants": [
    { "variant": null, "entered": 120, "sent": 118, "delivered": 64, "read": 41, "replied": 12, "dismissed": 9, "goalReached": 30, "conversationsStarted": 12, "clicks": { "yes": 10, "no": 9 } }
  ]
}
```

| Count | What it counts |
|---|---|
| `entered` | Contacts the campaign reached: a message made, or a place in the control group |
| `sent`, `delivered`, `read`, `replied`, `dismissed` | Messages that reached each status, on the day they reached it |
| `goalReached` | Messages after which the contact reached the goal, within its time |
| `conversationsStarted` | Messages that started a new conversation |
| `clicks` | Button choices by `value`: answers, links and dismissals |

`variant` is the variant's key, or null for a campaign with no variants. `variants` adds up the days for each one. Test visitors count nowhere. The results outlive the messages' text, which Dinghy removes 30 days after a message ended.

## Server events

Your server can tell Dinghy that something happened to a person, such as a finished export. Events come only from your server, with an API key, and never from the browser.

```ts
// server
await dinghy.track({
  visitor: { userId: "42" },
  name: "export.finished",
  properties: { rows: 1200 },
  id: "export-31",
});
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/track \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "visitor": { "userId": "42" }, "name": "export.finished", "properties": { "rows": 1200 }, "id": "export-31" }'
```

| Field | Value |
|---|---|
| `visitor` | `{ userId, name?, email?, attributes? }`, which creates or updates the contact, or `{ id }` |
| `name` | Up to 64 letters, digits, `_`, `.`, `:` and `-`, starting with a letter or a digit, such as `export.finished` |
| `properties` | Optional. Up to 4 KB of JSON, for `{{ event.properties.<key> }}` in an `event` campaign's text. Never stored |
| `occurredAt` | Optional. When it happened, such as `2026-12-01T09:00:00Z`. Now by default, and never later than now |
| `id` | Optional. Your own ID for this event, up to 100 characters. A repeat of one of the contact's last 20 IDs for this name counts once |

It answers `{ visitorId, counted }`, with `counted` false for a repeat. Dinghy keeps one row per contact and event name, with how often it happened and when, first and last, and no log, so nothing grows with traffic. Conditions read it:

- `events.<name>.count`, a number, 0 when it never happened, such as `{ "field": "events.export.finished.count", "op": "gte", "value": 3 }`;
- `events.<name>.lastAt`, a time, such as `{ "field": "events.export.finished.lastAt", "op": "older_than", "value": "30d" }`.

A track checks the contact's `match` campaigns that read the event, and runs the live `event` campaigns with that `name`. Each key may track 600 events a minute, apart from its 300 requests a minute. A member's session answers 403 `forbidden`.

## In the operator app

The **Campaigns** page lists the campaigns with their status and results, and filters them by status. The editor has a section for each part of the JSON:

- the audience, with a live count of the people who match now;
- the trigger, with "would have sent to N people in the last 7 days" for `match` and `event`;
- the message, beside a live preview of the widget with its variables filled for a sample contact, in light and dark, in each language and at phone width;
- under **More options**, the variants, the presentation, the delivery and the rules.

An attribute key or an event name suggests the ones your recent contacts have, from `GET .../contact-fields`, and takes a new one too. **Contacts > Attributes and events** lists them with how many contacts have each and the campaigns that read it. The variants' weights show as shares in percent, and a note says when they add up to another total.

**Go live** asks first, with what the campaign will do. The ⋯ menu holds **Send me a test**, which shows the message to a test visitor named after you, in a conversation you can open, whatever the rules say, and names the rule that would hold a real message now, such as `outside_business_hours`. It also holds **Copy as code**, which gives the JSON and the SDK call, and **Delete campaign** while the campaign never sent a message, or **End campaign** once it did. Deleting a live campaign pauses it first. Each row of the list has a menu with **Rename** and the same delete or end. A saved draft saves itself as you type, and a live or paused campaign waits for **Save**. **Pause all campaigns**, in the page's ⋯ menu while a campaign is live, sets the workspace's `paused`.

## The API

These routes are under `/v1/operator/workspaces/{workspaceId}`. A route on one campaign takes its ID, `/campaigns/{id}`, or its key, `/campaigns/by-key/{key}`, so a repository needs only keys. Every member and every API key reads campaigns. Owners, admins and Full access keys change them.

| Call | What it does | HTTP |
|---|---|---|
| `dinghy.campaigns.list({ status })` | Lists them, oldest first | `GET .../campaigns` |
| `dinghy.campaigns.get(ref)` | Reads one | `GET .../campaigns/{id}` |
| `dinghy.campaigns.create(definition)` | Creates a draft. A used key answers 409 `campaign_key_taken` | `POST .../campaigns` |
| `dinghy.campaigns.upsert(definition)` | Creates a draft, or replaces the campaign with this key | `PUT .../campaigns/by-key/{key}` |
| `dinghy.campaigns.update(ref, patch)` | Replaces the parts the patch gives | `PATCH .../campaigns/{id}` |
| `dinghy.campaigns.pause(ref)`, `resume(ref)`, `end(ref)` | Changes its status | `POST .../campaigns/{id}/pause`, `/resume`, `/end` |
| `dinghy.campaigns.delete(ref)` | Deletes one that never sent a message | `DELETE .../campaigns/{id}` |
| `dinghy.campaigns.results(ref, { from, to })` | Its results per day and variant | `GET .../campaigns/{id}/results` |
| `dinghy.campaigns.send(ref, { visitor, data?, clientId? })` | Runs it for one person | `POST .../campaigns/{id}/send` |
| `dinghy.track({ visitor, name, properties?, occurredAt?, id? })` | Tracks a [server event](#server-events) | `POST .../track` |

`ref` is a key, such as `"dns-help"`, or `{ id }`. Each route also works with `by-key/{key}` in place of `{id}`. [API](api.md#campaigns) has every route, with the campaign settings, the editor's estimate and the test.

A campaign answers `{ campaign }`, with `id`, `status`, `version` (one more on each save), `definition`, `totals`, `createdAt`, `updatedAt`, `liveAt` (when it last went live) and `endedAt`. Each change of a campaign sends a `campaign.updated` [webhook](api.md#webhooks) and event, with `data.campaign`.

### Keep campaigns in your repository

```ts
// server, in a deploy script
import { campaigns } from "./campaigns.ts";

for (const definition of campaigns) await dinghy.campaigns.upsert(definition);
```

An upsert saves a new campaign as a draft. Start it once with `resume`, from the code or the operator app. Later upserts keep its status.

### Send from your code

```ts
// server
await dinghy.campaigns.send("onboarding-done", {
  visitor: { userId: user.id },
  data: { plan: user.plan },
});
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/campaigns/by-key/onboarding-done/send \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "clientId": "onboarding-done-42", "visitor": { "userId": "42" }, "data": { "plan": "pro" } }'
```

A send runs a live campaign for one person, whatever its trigger. It skips the audience and the trigger, because your code chose the person, and keeps the frequency and the other rules. `data` fills `{{ data.<key> }}`: up to 20 keys of up to 40 letters, digits and `_`, each with text of up to 500 characters, a number or a yes or no.

It answers 201 with `{ outboundMessage }`. A retry with the same `clientId`, and a send that the frequency keeps out, answer 200 with the message that is there. The library makes a `clientId` when you give none. A send answers 409 `campaign_not_live` for a draft, a paused or an ended campaign, 403 `blocked`, 404 `not_found` for an unknown visitor `id`, and 429 `too_many_waiting`. Sends count in the key's 60 outbound messages a minute.

### MCP

Every key has `list_campaigns`, `get_campaign`, `get_campaign_results`, `send_campaign` and `track_event`. A Full access key also has `upsert_campaign`, `pause_campaign`, `resume_campaign`, `end_campaign` and `delete_campaign`. [Use Dinghy with AI agents](agents.md#campaigns) has more.

## Status reasons

Campaigns set these `statusReason` values on their messages, beside those of [Its life](outbound-messages.md#its-life):

| `statusReason` | Waits or cancels | Why |
|---|---|---|
| `audience_unmatched` | Cancels | The contact no longer matched the audience at the send time |
| `frequency_capped` | Cancels | Another campaign message reached the visitor within the workspace's gap |
| `goal_reached` | Cancels | The contact reached the campaign's goal |
| `outside_business_hours` | Waits | `businessHours` is on, and the team is closed |
| `outside_send_window` | Waits | It is outside `sendWindow` on the visitor's clock |
| `campaign_paused` | Waits | The campaign is paused, or every campaign is |
| `campaign_ended` | Cancels | The campaign ended |
| `control_group` | Cancels | The contact is in the control group, so no message went |
| `unless_matched` | Cancels | The contact matched `exitWhen` |

## Recipes

### A welcome, with no code

The [welcome recipe](outbound-messages.md#a-welcome-only-if-the-user-opens-the-chat) sends from the signup handler. The same with no code is a campaign for every signed-in user:

```json
{
  "key": "welcome",
  "name": "Welcome",
  "audience": { "field": "signedIn", "op": "eq", "value": true },
  "trigger": { "type": "match" },
  "message": {
    "sender": { "email": "julien@example.com" },
    "body": "Welcome! Any question about getting started? Ask me here."
  },
  "presentation": { "startConversation": "on_reply", "show": "badge", "ifConversationOpen": "skip" },
  "rules": { "frequency": "once" }
}
```

A user who signs in for the first time is a new contact, so Dinghy checks every live campaign for them, and this one matches. The campaign's results count the reads and the answers.

### Help on the pricing page, with no code

Support writes this campaign in the operator app and starts it. Nobody deploys anything:

```json
{
  "key": "pricing-help",
  "name": "Help on the pricing page",
  "trigger": { "type": "page", "url": "/pricing*", "seconds": 20 },
  "message": {
    "body": "Comparing plans? I can tell you which one fits.",
    "buttons": [{ "label": "Help me choose", "value": "help" }]
  },
  "presentation": { "startConversation": "on_reply", "show": "preview", "ifConversationOpen": "skip" }
}
```

To keep it in your repository instead:

```ts
// server
await dinghy.campaigns.upsert(pricingHelp); // the JSON above
await dinghy.campaigns.resume("pricing-help");
```

```sh
# server
curl -X PUT https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/campaigns/by-key/pricing-help \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d @pricing-help.json

curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/campaigns/by-key/pricing-help/resume \
  -H "Authorization: Bearer dk_..."
```

A rule of your own, such as "the third visit to the pricing page", belongs in your app: count it there, and send an [outbound message](outbound-messages.md#send-one) or a campaign from your code.

### Text in the operator app, trigger in your code

Support writes and edits the campaign `onboarding-done` in the operator app, with the trigger `api`:

```json
{
  "key": "onboarding-done",
  "name": "Onboarding done",
  "trigger": { "type": "api" },
  "message": {
    "sender": { "email": "julien@example.com" },
    "body": "You're all set on the {{ data.plan | default: \"free\" }} plan. Anything I can help with?"
  },
  "presentation": { "startConversation": "on_reply", "show": "preview", "ifConversationOpen": "hold" }
}
```

Your server sends it when onboarding ends:

```ts
// server
await dinghy.campaigns.send("onboarding-done", { visitor: { userId: user.id }, data: { plan: user.plan } });
```

```sh
# server
curl -X POST https://chat.example.com/v1/operator/workspaces/WORKSPACE_ID/campaigns/by-key/onboarding-done/send \
  -H "Authorization: Bearer dk_..." \
  -H "Content-Type: application/json" \
  -d '{ "clientId": "onboarding-done-42", "visitor": { "userId": "42" }, "data": { "plan": "pro" } }'
```

Support changes the text without a deploy, and the campaign's results show the read and reply rates.
