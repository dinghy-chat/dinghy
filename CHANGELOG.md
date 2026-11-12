# Changelog

This file lists the changes in each release of Dinghy. Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Dinghy uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may break things, so read **Upgrading** before you upgrade.

## [Unreleased]

### Added

- **Settings > Appearance** has a **Header** section: the faces beside the chat's title are the members online now (the default, with the latest repliers when nobody is), the latest repliers, members you choose and order, or none, 1 to 5 of them, with a green dot on each member online. The status line can say "Usually replies in 2 min", from the 30-day median first reply time. API: the widget settings have `headerFaces`, `headerFaceCount`, `headerDot`, `headerStatus` and `headerMembers`, the appearance answers `faces`, and the widget's presence answers `members` and `replySeconds`.
- The user menu sets you **Available** or **Away**, in every workspace, with a dot on your picture. While you are away, the widget does not count you online. API: `PUT /v1/operator/me/status`, and `away` on `/v1/operator/me`.

### Changed

- A background tab of the operator app keeps you online for the widget, as most of the time the inbox waits in one. A hidden tab marks you online for 2 minutes per beat, as browsers slow its timers, and shows no conversation as open. API: the operator's presence beat takes `hidden`.
- The Inbox's red number, and the workspace switcher's, count only the conversations waiting for a reply that are assigned to you or to nobody. The tab's icon gets a red dot while one waits, and an installed app shows the number on its icon. API: `waiting` in the conversation list and in the waiting counts follows the same rule for an operator, and still counts all for an API key.
- The Inbox's Open, Closed, All, Mine and Unassigned choices are in a card behind a filter button beside the search, with a dot when a filter is set. The message menu is smaller and never cut off by the thread or the reply field, and hovering a message no longer moves the thread.
- **Visitors** has an interactive map: hover a country for who is there, click it to zoom and list only its people, drag and scroll to move and zoom. People who used the chat show their name, **Open chat** and **View contact**. Everyone, Chatting and Known filter the list, and two tiles count the pages open now and where people came from. A referrer from the site itself no longer counts.
- **Analytics** shows four key numbers with their change against the previous period of the same length, conversations per day with a scale, what happened to the conversations, the busiest hours with the peak marked, and who replies first. API: the analytics answer adds `previous`, returns `firstReply.fast` as a count instead of `within5Minutes`, and replaces `operators` with `repliers`, each an operator, an API key or a former member.
- The conversation's visitor panel has a new look. Its head shows the visitor on a soft blue, with their place, local time, device and current page (the last page once they leave) as tiles. The assignee and the status sit in one row under it. Long values stay on one line, the pages visited form a timeline, folds show their item count, and the note looks like a sticky note. **View contact** is an icon in the head, and the user ID moved to **Details**. The panel slides in and out when you show or hide it, unless the device asks for reduced motion.
- A contact's page has a new look: the person on a soft blue with **Signed in**, their company, email and whether they are on your site now, **Open conversation**, and a **…** menu to edit a signed-out visitor's name and email, block or unblock them, or delete the contact. Tiles show local time, location, device, first seen and conversations. **Conversations** and **Pages visited** are tabs: each conversation shows its message count, assignee or who closed it, and first reply time, and the pages group by visit with the current page marked **Here now**. The note and **Details from your site** sit beside them, where page context shows in italics and links and IDs have copy buttons. API: a contact adds `online`, and each of its conversations adds `messageCount`, `assigneeName`, `closedBy` and `firstReplySeconds`.

## [0.21.0] - 2026-11-12

### Upgrading

- The Docker image downloads DB-IP's free IP to Country Lite database when it is built, for the countries in the new live view. Nothing to set. A server built from source can point `GEOIP_COUNTRY_FILE` at a copy, and without one the live view shows no countries.

### Added

- Messages show a small Markdown: bold, italic, code, code blocks, links, bare web addresses and lists, in the widget, in the operator app and in the HTML part of reply emails. HTML, images and headings stay text, and links work only for `http`, `https` and `mailto`.
- Under the last reply, the thread shows **Sent**, **Sent by email**, **Email failed** or **Read in chat**, and it changes live when the visitor reads. Point at an earlier reply to see its own.
- API: `GET /v1/operator/workspaces/{id}/conversations/{conversationId}/messages` answers `receipts`, with the exact range of messages each email carried, and the operator stream sends `notice` events, which carry no cursor and may be lost.
- Operators see what a visitor types before they send it, live, in the thread and in the Inbox list. Nothing stores it. **Settings > Workspace** turns it off, and the widget then sends nothing. API: `POST /v1/widget/{key}/typing` and `PUT /v1/operator/workspaces/{id}/widget/typing-preview`, and the appearance answers `typingPreview`.
- **Contacts** in the sidebar lists everyone who started a conversation, with search, sorting, paging and **Export CSV**. A contact's page shows what the team knows, every conversation, the pages they visited and a private note. A signed-out contact's name and email can be corrected, and owners and admins can delete a contact with all their conversations. API: `/v1/operator/workspaces/{id}/contacts`.
- A conversation has a panel on its right with the visitor, the assignee and status, the details, the pages visited, their other conversations and the team's note. The header's button shows or hides it, and each fold remembers whether it is open.
- **Visitors** in the sidebar shows who is on your site now, on a world map and in a list with their country, local time, page, time on site, device and where they came from, and links to the conversation of a visitor who is chatting. The sidebar counts them. Each tab of a page with the widget sends a beat a minute while it shows, with a random ID that lives only in the page's memory. The server finds the country from the address and drops the address, and keeps the live view in Valkey only. For a visitor who has chatted, it saves their country and time zone. API: `POST /v1/widget/{key}/beat`, `POST /v1/widget/{key}/leave`, and `GET /v1/operator/workspaces/{id}/visitors/live` and `/visitors/live/count`.
- **Get started** at the foot of the sidebar, for owners and admins, shows how many of six first steps are done, with a ring, and opens them: install the widget, add a logo, customize the widget, invite a teammate, turn on notifications, and send a test chat. The server checks each step, and **Hide for good** hides them for the member on every device. API: `GET /v1/operator/workspaces/{id}/get-started` and `POST .../get-started/dismiss`.
- Closing or reopening a conversation writes a small centered line in both the thread and the widget, such as "Julien closed this conversation" and, for the visitor, "This conversation is closed. Write to us again any time." It stays after a reload, and it never alerts anyone or shows as the Inbox preview. API: a message's `kind` can be `closed` or `reopened`, with a null `body`.
- The widget plays the operator app's soft two-note chime when a reply arrives while the chat is closed or its tab is hidden, at most once every 2 seconds. **Settings > Appearance** turns it off with **Play a sound for new replies**. API: the widget settings have `sound`.
- Dinghy Cloud's welcome chat shows the founder's picture in the Inbox row, the thread's header and next to the founder's messages. API: `visitor.pictureUrl` on a conversation, null except there, and `pictureUrl` on a `founder` welcome.
- In the Inbox, **All**, **Mine** and **Unassigned** sit under **Open** and **Closed** as one filter block, each with its count of open conversations. The workspace menu shows how many chats wait in each workspace, and a dot on the menu's button says when chats wait in another one. API: `openBy` on the conversation list, and `GET /v1/operator/waiting`.
- An API key has an access level, chosen when it is made: **Conversations**, as before, or **Setup**, which also manages webhooks, so an agent can connect Dinghy by itself. Settings shows each key's level, and who added each webhook. MCP gives a Setup key `list_webhooks`, `create_webhook`, `delete_webhook` and `test_webhook`. API: `level` on keys, the `setupKey` security scheme on the webhook routes, and `createdBy` on webhooks. Existing keys are Conversations keys.
- When a conversation closes, a visitor who gave an email gets the whole conversation by email 5 minutes later, with times in UTC, the workspace's logo and a link to continue the chat, if someone on the team replied. A quick reopen cancels it. A reply email due before it waits for it and leaves out the replies it carried, so the visitor does not get a reply twice, and it carries them when the transcript fails or is cancelled. Transcripts count toward the visitor's 5 emails a day. **Send transcript** in a conversation's **…** menu sends it now, and **Settings > Appearance** turns the email at close off. API: `POST .../conversations/{conversationId}/transcript`, the `transcript` widget setting and the `transcript.requested` event.
- The reply box has a row of tools: attach, emoji, then bold, italic, code, link, bulleted and numbered lists, with Cmd or Ctrl with B, I, E and K.
- Reply to one message with a quote, as in WhatsApp or Slack. In the operator app, the **…** beside a message has **Reply**; in the widget, visitors reply to the team's messages from the small reply button. The reply shows a quote of the message above its text, and a click on the quote scrolls to it. Reply emails and transcripts show the quote too. API: `replyToMessageId` on sends and on the MCP `reply` tool, and `replyTo` on every message.
- Each message in the operator thread has a **…** menu: **Reply**, **Copy text**, **Edit** for your own reply until the visitor has seen it, **Info** with the time, the author and the receipt, **Copy link** to the message, and **Delete**. Operators delete their own messages, and owners and admins anyone's. A deleted message stays as "Message deleted" on both sides, and its image is removed. API: `PATCH` and `DELETE` on `.../messages/{messageId}`, `GET .../messages/{messageId}/receipt`, `editedAt`, `deleted`, `readAt` and `via` on messages, and the `message.updated` and `message.deleted` events and webhooks.

### Removed

- The first steps under an empty inbox, which **Get started** replaces.

### Changed

- The panel on the right of a conversation replaces the **Visitor details** fold above the messages.
- An invite for an email that already has an account says, before the click, that a sign-in link comes by email first, and its button says **Email me a sign-in link**. That email is titled "Join <workspace> on Dinghy" and names who invited. A signed-in invitee still joins in one click.
- The widget's header is one compact row with a one-line status, and its message box holds the attach, emoji and send buttons. The thread's header is one slim row; the visitor's email, user ID, device and page are in the panel, where the user ID has a copy button. The Inbox search says only **Search**. A sent invite shows a centered confirmation.
- An operator's first reply in an unassigned conversation assigns it to them, with the usual `conversation.assigned` event. A reply from an API key never assigns, and a conversation that has an assignee keeps it.
- The inbox's **Open** and **Closed** choice fills the list's width, and **Open** shows how many conversations are open. The sidebar and the conversation list are narrower, so the conversation gets more room.
- The empty Analytics page centers its boat in the card.
- API: `GET /v1/operator/workspaces/{id}/conversations` answers `open`, the open conversations for its assignee filter.

### Fixed

- A chat left open in a tab no longer opens again after a reload when the operator closed its conversation. After a reload, the chat opens again only for an open conversation or a new, empty chat, and only once the server answers, so it never flashes open and shut.

## [0.20.0] - 2026-11-11

### Added

- `Dinghy.on("conversation", (open) => ...)` and `Dinghy.state.conversation` say whether the visitor has an open conversation. With `data-launcher="hidden"`, a page can show the chat's button only during a conversation, on every device of a signed-in user.

## [0.19.0] - 2026-11-11

### Changed

- **Delete my account** works at once for a workspace's only owner. A workspace with other people in it passes to the admin who joined first, or else to the member who joined first. A workspace with nobody else in it is deleted with the account, and on Dinghy Cloud its subscription ends. The dialog lists what happens to each one. A self-hosted server still keeps its last workspace.
- Docs links in Settings sit under each section's description, with a book icon.
- "Saved." and other confirmations show as a short message at the bottom of the screen. A failure still shows next to its field.
- **Allowed sites** lists each site as a card. **Add a site** opens the field, and each add or remove saves at once.
- The picture and the logo have smaller buttons, with the file rule beside them.
- The preview in **Settings > Appearance** shows a dark chat on a light page, so it stands out.
- API: `GET /v1/operator/me` answers each workspace's `heir`. `POST /v1/operator/account/delete` no longer answers `sole_owner`. It answers `last_workspace` on a self-hosted server whose last workspace has only this operator, `billing_unavailable` when a subscription could not be canceled, and `team_changed` when someone left a workspace during the delete.

### Fixed

- `Dinghy.open({ message })` keeps words the visitor already typed in the message box.
- The tip on a blocked leave button shows all its words.

## [0.18.0] - 2026-11-11

### Added

- Settings is one page: a list grouped into **You**, **Workspace**, **Chat widget** and **Developers**, with the open page beside it. Each page has its own address, such as `/settings/team?workspace=<id>`, so a link or a bookmark opens the same page of the same workspace. On a phone the list is its own screen, and each page has a way back.
- A **Workspace** page in Settings, where owners and admins rename the workspace and change its logo. It also holds the plan and usage, billing, blocked visitors, the export and the delete.
- The Inbox lists open or closed conversations, and in a team, all of them, yours or the unassigned ones. The address keeps the choice, and Back and Forward bring it back.
- An emoji picker in the chat's message box, for visitors and operators, and in the widget's words in **Settings > Appearance**.
- Two more chat buttons: **Label**, a pill with the chat's title, and **Square**, which takes the saved corners. `data-launcher` takes `label` and `square`.
- On Dinghy Cloud, `chat free <workspace-id>` turns on a workspace that never pays, such as your own.
- API: `PATCH /v1/operator/workspaces/{workspaceId}` renames a workspace. `GET /v1/operator/workspaces/{workspaceId}/conversations` takes `assignee=me` or `assignee=none`. `GET /v1/operator/me` answers each workspace's `logoUrl`. The billing state can be `free`.

### Changed

- The sidebar keeps **Inbox**, **Analytics** and **Settings**. **Closed** moved into the Inbox, **Alerts** is **Settings > Notifications**, and **Profile** is a page of Settings too.
- In Settings, the **Widget** tab is now **Appearance**, **API** is **API & webhooks**, and **Allowed sites** and the identity secret are on **Install**. **Data** moved to the **Workspace** page.
- The chat button is a bubble by default. A saved widget keeps its button.
- **Settings > Appearance** has a compact **Colors and layout** section and an **Email and branding** section. Its preview shows the open chat and the chat button together, on a light page behind a light widget. Pasting a hex code sets a color.
- The save note in **Settings > Appearance** says that new pages of your site show the change within 5 minutes. A page that is already open keeps the look it loaded with.
- The forms for a new API key and a new webhook open when you ask for them.
- A webhook delivery's error says what to check next, and a failed test says so once.
- Renaming the workspace or changing its logo shows in every operator's open app.
- **Cancel** leaves the setup of an extra workspace.
- A tip says why the leave button is off for a workspace's only owner.
- Focus shows in the app's navy, with a warm halo on fields.

### Fixed

- Back and Forward ask before they drop unsaved changes in **Settings > Appearance**, and **Stay** keeps the page and its address.
- **Settings > Appearance** fits a phone without scrolling sideways.
- The open chat has no white edge at its top corners.
- A disabled red-outline button looks disabled.

## [0.17.0] - 2026-11-11

### Added

- A **Widget** tab in Settings changes the chat with no code: the logo, the words, the main and accent colors, the side, a light, dark or auto theme, the chat button (boat, bubble or hidden), the corners, the boat in the open chat, when to ask for an email, and the "Powered by Dinghy" line. A live preview shows each change before you save, open or closed, light or dark. Your site shows a saved change within 5 minutes. Every member sees the tab, and owners and admins change it.
- Each operator can set a picture in **Profile**. Visitors see it, with the operator's first name, on each reply and at the top of the chat. Your team sees it in place of initials. A reply from an API key shows the key's name and a bot icon.
- The chat can ask for an email before the first message, in place of the message box, and has a dark theme.
- A "Powered by Dinghy" line under the chat, on by default. The Widget tab or `data-branding="off"` hides it.
- API: `GET` and `PUT /v1/operator/workspaces/{workspaceId}/widget`, `GET /v1/widget/{key}/appearance`, `PUT` and `DELETE /v1/operator/me/picture`, and `GET /v1/pictures/{operatorId}`. Widget messages have `fromBot`, `authorName` and `authorPictureUrl`. `GET /v1/operator/me` and the members list answer `pictureUrl`.

### Changed

- The loader asks for the saved look on each page view, and draws the chat button once it arrives. The browser keeps the answer for 5 minutes.
- `data-launcher` takes `boat`, `bubble` or `hidden`. `data-mascot="false"` now hides only the boat in the open chat, and no longer changes the chat button: use `data-launcher="bubble"` for that.
- The chat's corners and the boat button's are 16 pixels by default, and the Widget tab sets them.
- Visitors see the replying operator's first name.
- The logo, the title, the greeting and the away text moved from **Install** to **Widget**. Install keeps the tag.
- An export holds all the widget's settings, so an export from an earlier release no longer imports.

### Removed

- API: `GET /v1/widget/{key}/presence` no longer answers `texts` and `logoUrl`, and the settings no longer take or answer `widgetTexts` and `logoUrl`. The logo routes moved to `/v1/operator/workspaces/{workspaceId}/widget/logo`.

## [0.16.0] - 2026-11-10

### Changed

- On Dinghy Cloud, the sign-in page emails an address with no account a link to signup, instead of sending nothing. A self-hosted server still writes only to its operators.
- A new account's workspace setup no longer shows **Delete my account**. An account that was in a workspace still finds it there.
- API: each conversation has `welcome`, true for a welcome chat on Dinghy Cloud.

## [0.15.0] - 2026-11-10

### Added

- Operators can delete their account from **Profile**, and from any screen they see without a workspace. If they are the only owner of a workspace, they first delete it or make someone else an owner. An email link confirms the deletion, or the operator types their email when the server has no mail. Their name and email are erased, and their old messages show "Former team member".
- The workspace delete dialog lists what goes (conversations, images and team members) and offers the export first. After the delete, the app opens your next workspace.

### Changed

- A self-hosted server keeps its last workspace: the delete dialog says why its button is off.
- The docs pages on the website are built from `docs/*.md` when the site deploys, and are no longer in the repository.
- Settings shows the install code on one line, colored as in the docs. A new webhook's events are checkboxes, each with its code name.

### Fixed

- Switches are easier to see in both themes. A saved webhook's row shows its address again.

## [0.14.0] - 2026-11-10

### Changed

- Sending an invite waits for the mail server. The dialog then says who it went to, with **Invite someone else** and **Done**. If the address doesn't exist or the email can't be sent, the dialog says so, and the invite is revoked.
- The invite page names the workspace and who invited you: "Join Acme", "Ana invited you@example.com to join as an admin."
- API: `POST /v1/operator/workspaces/{workspaceId}/invites` answers 422 `email_rejected` when the mail server refuses the address, and 502 `mail_failed` when the email could not be sent. `POST /v1/invites/preview` answers `inviterName`.

## [0.13.0] - 2026-11-10

### Upgrading

- An invite now goes to one email address. The upgrade revokes the invites that are still pending, so invite those people again.
- The `agent` role is now `member`, in the app and in the API. The upgrade renames it for everyone. A script that sends or reads `"agent"` must use `"member"`.

### Added

- **Invite someone** asks for an email. With a mail server, Dinghy emails the invite. Without one, it shows a link to send yourself. Inviting the same email again replaces the old invite.
- Someone new joins from the invite with a name only, in one step. Someone who already has an account gets a link by email to join, or accepts while signed in with that email.
- API: `POST /v1/operator/workspaces/{workspaceId}/invites` takes `email`, answers 409 `already_member` for someone already in the workspace, and its `token` is null when the invite went by email. Pending invites list their `email`.
- API: `POST /v1/invites/preview` answers `email` and `hasAccount`.
- API: `POST /v1/operator/invites/accept` answers 403 `invite_other_email` when the invite is for another email.

### Changed

- The invite dialog picks the role with two buttons and says what each role can do.
- A pending invite shows its email, and revoking it asks first.
- API: `POST /v1/invites/join` takes `{ token, name }` and answers `{ workspaceId }`: the new account's workspace, or null when a link went to an existing account's email.

## [0.12.0] - 2026-11-10

### Changed

- The dashboard has calmer colours: a warm grey frame instead of the yellow, navy for your own messages instead of the bright blue, lighter shadows, outline icons without the tinted fill, the theme choice on the Profile page instead of the account menu, and off-white buttons at night instead of yellow. The sign-in screens keep the yellow sky.
- An empty Inbox shows a small drawing of the boat by day, and an empty Closed list shows it under the moon. Closed also says that closed conversations appear there.

## [0.11.0] - 2026-11-10

### Upgrading

- `chat import` reads only exports made by this version, because an export now holds API keys and what the page sent with `setContext()`.

### Added

- API keys. Owners and admins create them in **Settings > API**, and the token shows once. A key works only in its own workspace, with an agent's permissions: it reads, searches, replies, closes, reopens and assigns conversations, with `Authorization: Bearer dk_...` and no `Origin`. Its replies show its name. Each key may send 300 requests a minute.
- Webhooks. Owners and admins add up to 5 in **Settings > API**, for `conversation.created`, `message.created`, `conversation.closed`, `conversation.reopened` and `conversation.assigned`. Each request is signed with `Dinghy-Signature` and carries a `Dinghy-Event-Id` that stays the same on retries. A failed send is tried again for about a day. **Send test** sends one at once, and **Deliveries** shows the last 20.
- Webhooks go only to `https` addresses on the public internet, checked each time they send. `WEBHOOK_ALLOW_PRIVATE=true` lets a self-hosted install send over `http` and to its own network.
- An MCP server at `/v1/mcp`, with an API key, so an AI agent such as Claude Code can list, search, read, answer, close, reopen and assign conversations.
- The widget's browser API has `open({ message })`, `toggle()`, `show()`, `hide()`, `setContext()`, `configure()`, `on(event, callback)` and `state`. The events are `ready`, `open`, `close`, `unread`, `message:sent`, `message:received` and `conversation:started`.
- `Dinghy.setContext()` sends details from the page, such as a plan, for a visitor who has chatted. Operators see them under **From the page**, marked as not verified, and the API returns them as `pageContext`.
- The tag takes `data-position`, `data-offset-x` and `data-offset-y`. A page can set the CSS variables `--dinghy-font`, `--dinghy-radius` and `--dinghy-launcher-radius` on the `dinghy-chat` element.
- A chat that was open opens again after a reload in the same tab, for a visitor who has chatted or is signed in.
- The `@dinghy-chat/widget` npm package, with `init()` and the API's types.
- `llms.txt` on dinghy.chat, and a prompt in the docs to ask a coding agent to install Dinghy.

### Changed

- `Dinghy.onUnreadChange(callback)` is gone. Use `Dinghy.on("unread", callback)`, which also calls back at once with the count.
- Analytics' `operators` entries have `apiKeyId`, and `operatorId` is null for a reply sent with an API key.

## [0.10.0] - 2026-11-10

### Added

- `SENTRY_DSN` sends the server's errors to your own Sentry project. Without it, Dinghy sends nothing anywhere.

## [0.9.0] - 2026-11-10

### Changed

- The theme choice (system, light or dark) is in the menu under your name, not on Profile.

## [0.8.0] - 2026-11-09

### Added

- The operator app has a dark theme. It follows the device, and Profile can fix it to light or dark on one device.
- The analytics charts show the count and the day or hour under the pointer.
- The search field shows a ring while a search runs.

### Fixed

- The sidebar starts at the top of the window when a banner shows.
- The Delete item in a conversation's menu is no longer a red block with red text.
- The search field is white, not cream.

## [0.7.1] - 2026-11-09

### Changed

- The bundled Caddy image has the latest security fixes.
- The server uses web-push 4.0 for push notifications, and the widget uses Preact 11.2.

## [0.7.0] - 2026-11-09

### Upgrading

- The identity token must send custom attributes as `attributes`. The server no longer reads `claims`.
- A `name` inside `attributes` is no longer the visitor's name. Send it as the token's own `name`.
- `chat import` reads only exports made by 0.7.0.
- The migration adds Postgres's `btree_gin` extension and rebuilds the search index, which takes a moment on a large install.

### Changed

- Search needs 3 characters or more.
- On a phone, the open chat fills the screen and keeps clear of the notch and the home bar. On a computer, it still floats in the corner.
- A visitor with no name gets the first two characters of their code as initials, such as "7F" for "Visitor 7F3K".
- Headings and short texts in the operator app break their lines more evenly. The **Visitor details** row is 44 px tall on a phone.

### Fixed

- The widget's header no longer shows Dinghy's title before the workspace's own title.
- The blocked list shows a signed-in visitor's name.

### Security

- The server checks the operator's session and membership after the whole request body arrives. Before, a removed member could finish a slow write for up to 5 minutes.

## [0.6.0] - 2026-11-09

### Upgrading

- The operator API's visitor field `claims` is now `attributes`. Update any client that reads it.
- The migration adds Postgres's `pg_trgm` extension and builds a search index, which takes a moment on a large install. The database's owner can add it without superuser rights.

### Added

- The identity token takes an optional `name`, up to 100 characters. The operator app shows it as the visitor's name.
- A custom attribute whose value is an `http://` or `https://` address shows as a link.
- The conversation header shows whether the visitor is online or when they were last seen, their browser and system, and their last page. Online state needs Valkey.
- **Pages visited** lists the pages a visitor went through, newest first, once they have chatted. Dinghy keeps the newest 100 and deletes pages after 90 days.
- Owners and admins can change the chat's title, greeting and away text in **Settings > Install**.
- The operator app can play a soft chime for a new visitor message. **Alerts > Play a sound for new messages** turns it off on this device.
- A search box above the conversation list finds conversations by the visitor's name, email or user ID, or by message text.
- **Analytics** shows conversations per day, time to the first reply, conversations closed and the busiest hours, for the last 7, 30 or 90 days.
- An export holds the widget's texts, the visitors' pages, and each visitor's device, last page and last-seen time.
- API: `POST /v1/widget/{key}/page`.
- API: `GET /v1/operator/workspaces/{workspaceId}/conversations/search`.
- API: `GET /v1/operator/workspaces/{workspaceId}/analytics`.
- API: a conversation's messages have `visitorPages` and `visitorOnline`.
- API: the widget's `me` answer has `chatted`, and its presence answer has `texts`.
- API: the settings have `widgetTexts`, and the settings `PATCH` takes `allowedOrigins`, `widgetTexts` or both.
- API: a new message's `change` event has `fromVisitor`.

### Changed

- The reply email to a visitor links to a page on your Dinghy server, where they can read and reply. Each link works for 30 days.
- A `name` in the token's attributes is the visitor's name when the token has no `name` of its own.
- A conversation's attributes and pages sit in **Visitor details**, folded on a phone so the messages come first.
- Settings fits a phone. The tabs wrap, and **Invite** sits in the title row of **Team**.
- An invite link that expired or was used shows a heading and a way on: **Sign in** or **Open Dinghy**.
- When nobody is online, the widget says "we will reply here" once, in its header.
- On a touch screen, opening the chat no longer brings up the keyboard.
- Fields have darker borders, and buttons, tabs and dropdowns on a phone are at least 44 px tall.

### Deprecated

- The identity token's `claims` field is now `attributes`. Tokens that send `claims` still work in 0.6.0.

### Fixed

- `Dinghy.reset()` no longer leaves a key in the browser's storage for a visitor who never chatted.

## [0.5.0] - 2026-11-08

### Changed

- The operator app has a new look in the brand's yellow, with a sidebar for **Inbox**, **Closed**, **Alerts** and **Settings**.
- Every dropdown is the app's own and works fully with the keyboard.
- The conversation header shows the user ID and the starting page. **Block** and **Delete** moved to its **…** menu.
- Each run of messages shows its time, and its author for an operator. A line splits the days.
- Settings has tabs: **Team**, **Install**, **Allowed sites**, **Signing secret** and **Data**.
- **Profile** and **Sign out** moved to the menu under your name. The workspace name at the top switches workspaces.
- The app says why a workspace's last owner cannot lose the owner role or leave.
- The sign-in, link and setup screens change in place, with no page load.

## [0.4.1] - 2026-11-08

### Added

- On Dinghy Cloud, the logo on the sign-in, signup and link screens links to dinghy.chat. A self-hosted server's screens keep a plain logo.

## [0.4.0] - 2026-11-08

### Upgrading

- Operators now sign in with a link sent to their email, and passwords are gone. Tell your team. The upgrade deletes the stored password hashes.
- Without a mail server, make a link for an operator with `docker compose exec app chat sign-in-link <email>`.
- Accounts, workspaces and open sessions stay.

### Added

- `chat sign-in-link <email>` prints a sign-in link for an existing operator.
- The audit log has `sign_in.limited`, `sign_in.link_sent`, `sign_in.link_used` and `sign_in.link_refused`.
- API: `POST /v1/invites/open` uses a join link.
- API: `POST /v1/auth/magic-link/verify` with `{ token }` uses a sign-in link.
- API: `/v1/meta` has `email`, true when sign-in links go by email.

### Changed

- A sign-in link works once, for 15 minutes. It opens a page with one button, so a mail scanner cannot use it up.
- Joining by invite asks for a name and an email, then emails a link that joins the workspace and signs in.
- `chat setup`, `chat create-operator`, the installer and `bun run dev` print a sign-in link instead of a password.
- Every email has a new, shorter text. The reply to a visitor is signed by the workspace, not by Dinghy.
- API: `POST /v1/invites/join` takes no `password` and answers `{ ok, signInUrl }`.
- API: `POST /v1/signup` takes no `password` and answers `{ ok }`.

### Removed

- `chat reset-password`, the change-password card in Settings, and the forgot and reset password pages.
- The email confirmation step from 0.3.5. Opening a link now confirms the email.
- The audit log's `sign_in.failed`.
- API: the password routes under `/v1/auth`. Every `/v1/auth` route the app does not use answers 404.

### Security

- The sign-in page gives the same answer whether or not the email has an account.
- An email gets at most 5 links an hour from one address and 20 from all, and one address can ask for 30 emails an hour.

## [0.3.7] - 2026-11-08

### Changed

- The image is public at `ghcr.io/dinghy-chat/dinghy`, so an install needs no registry login.

### Fixed

- `chat workspaces` prints the state that the API and the widget act on, such as `read_only` or `waiting_payment`. It used to print `active` for those.

## 0.3.6 and earlier

- Live chat with images, in a small widget for your site, and an operator app for several operators per workspace, with push and email alerts.
- Signed-in visitors through an identity token signed by your server, and anonymous visitors with a browser token.
- A one-command install with `install.sh`: Docker Compose, Postgres, Valkey and Caddy, with a certificate and a nightly backup.
- `chat backup` and `chat restore`, with an optional encrypted copy in S3, and the steps to move Postgres to a new major version.
- Workspace export and import, workspace suspension, a separate origin for images, health checks and metrics.
- AGPL for the server, MIT for the widget, and the cloud's billing code in `ee/`, which stays off unless its settings are set.

[Unreleased]: https://github.com/dinghy-chat/dinghy/compare/v0.21.0...HEAD
[0.21.0]: https://github.com/dinghy-chat/dinghy/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/dinghy-chat/dinghy/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/dinghy-chat/dinghy/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/dinghy-chat/dinghy/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/dinghy-chat/dinghy/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/dinghy-chat/dinghy/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/dinghy-chat/dinghy/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/dinghy-chat/dinghy/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/dinghy-chat/dinghy/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/dinghy-chat/dinghy/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/dinghy-chat/dinghy/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/dinghy-chat/dinghy/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/dinghy-chat/dinghy/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/dinghy-chat/dinghy/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/dinghy-chat/dinghy/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/dinghy-chat/dinghy/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dinghy-chat/dinghy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dinghy-chat/dinghy/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/dinghy-chat/dinghy/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/dinghy-chat/dinghy/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/dinghy-chat/dinghy/compare/v0.3.6...v0.3.7
