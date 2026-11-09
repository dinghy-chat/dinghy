# Changelog

This file lists the changes in each release of Dinghy. Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Dinghy uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may break things, so read **Upgrading** before you upgrade.

## [Unreleased]

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

[Unreleased]: https://github.com/dinghy-chat/dinghy/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/dinghy-chat/dinghy/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/dinghy-chat/dinghy/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/dinghy-chat/dinghy/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dinghy-chat/dinghy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dinghy-chat/dinghy/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/dinghy-chat/dinghy/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/dinghy-chat/dinghy/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/dinghy-chat/dinghy/compare/v0.3.6...v0.3.7
