# Changelog

Each release says what changed and what an owner must do. To move Postgres to a new major version, a release says so, and `docs/self-hosting.md` has the steps.

## Unreleased

- A `name` string in the identity token's `claims` is the visitor's name in the operator app: the conversation's title in the inbox, the conversation header and the blocked list. The email and user ID move to the line under it.
- Settings fits a phone: the tabs wrap so every one stays visible, and **Invite someone**, now only on **Team**, is a short **Invite** in the title row. The install snippet has one attribute per line, so no screen breaks it inside `data-key`.
- An invite link that expired or was used shows a heading and a way on, **Sign in** or **Open Dinghy**, instead of a line of red text.
- **Delete workspace** is an outline button, like **Replace the secret**. The confirm step keeps the filled red one.
- Fields have a darker border, at 3:1 on white, and buttons, tabs and dropdowns on a phone are at least 44 px tall.
- On a touch screen, opening the chat no longer brings up the keyboard. Tapping the message field does. With a mouse, the field gets focus as before.
- When nobody is online, the widget says "we will reply here" once, in its header.
- Dinghy Cloud's early signup says what it is: the workspace works right away, and an email comes when the cloud opens. The button reads **Email me a sign-up link**, the workspace name has a hint, and the banner in the app is one short line.

## 0.5.0 (2026-11-08)

- A new look for the operator app, in the brand's yellow: a sidebar with **Inbox**, **Closed**, **Alerts** and **Settings**, and one white panel with a title, a line of context and the page's actions.
- Every dropdown is the app's own, with full keyboard use. The conversation header shows the user ID and the starting page under the name, and **Block** and **Delete** moved to its **…** menu. Each run of messages shows its time, and its author for an operator, and days are split by a line.
- Settings has tabs: **Team**, **Install**, **Allowed sites**, **Signing secret** and **Data**. **Invite someone** opens a dialog. Allowed sites take one site per row, and the signing secret stays hidden until shown. On Dinghy Cloud, the plan's use shows as two bars.
- **Profile** and **Sign out** moved to the menu under your name, at the bottom of the sidebar. The workspace name at the top switches workspaces, and on Dinghy Cloud creates one.
- The app keeps a workspace's last owner: their role cannot be lowered and they cannot leave, and the app says why. The server already refused both.
- The sign-in, link and setup screens change in place, with no page load, and their sky moves from morning to afternoon as you go. The link page names what its button does, such as **Sign in** or **Join the team**.

## 0.4.1 (2026-11-08)

Follow the upgrade steps in `docs/self-hosting.md`; nothing else is needed.

- On Dinghy Cloud, the logo on the sign-in, signup and link screens goes back to dinghy.chat. A self-hosted server's screens keep a plain logo.

## 0.4.0 (2026-11-08)

**Owner action:** operators now sign in with a link sent to their email, and passwords are gone. Tell your team: they enter their email on the sign-in page and open the link, which works once, for 15 minutes. Without a mail server, the sign-in page tells them to ask you, and you make a link with `docker compose exec app chat sign-in-link <email>`. The upgrade deletes the stored password hashes. Accounts, workspaces and open sessions stay.

- The sign-in page asks for an email and answers "Check your email" whether or not the email has an account. A link works once and lasts 15 minutes, and the database keeps only a hash of it. An email gets at most 5 links an hour from one address and 20 from all, and one address can ask for 30 emails an hour.
- `chat sign-in-link <email>` prints a link for an existing operator. It replaces `chat reset-password`. `chat setup`, `chat create-operator`, the installer and `bun run dev` print a sign-in link instead of a password.
- Joining by invite asks for a name and an email, and emails a link that creates the account, or uses the one the email has, joins the workspace and signs in. Without a mail server, a new person signs in at once, and an email that has an account gets `email_taken`. `POST /v1/invites/join` takes no `password` and answers `{ ok, signInUrl }`, and the new `POST /v1/invites/open` uses a join link.
- On Dinghy Cloud, signup asks for an email only. The link proves the email and signs in, and the workspace setup follows. An email that has an account gets a sign-in link instead, with the same answer. `POST /v1/signup` takes no `password` and answers `{ ok }`.
- Removed: the password routes under `/v1/auth`, the change-password card in Settings, the forgot and reset password pages, and the email confirmation step from 0.3.5, which opening a link now does. Every `/v1/auth` route the app does not use answers 404. `/v1/meta` has `email`, true when sign-in links go by email.
- Every link in an email, and the one `chat sign-in-link` prints, opens a page of the operator app with one button, such as **Sign in to Dinghy**. Only the button uses the link, so a mail scanner that opens links cannot use one up. `POST /v1/auth/magic-link/verify` with `{ token }` uses a sign-in link, and `GET /v1/auth/magic-link/verify` answers 404.
- Every email has a new, shorter text with the same facts: the sign-in, join and signup links, the note to an email that already has an account, the welcome, the new message alert, the reply to a visitor and the three billing emails. The welcome lists only the steps that work before the cloud opens, and the reply to a visitor is signed by the workspace, not by Dinghy.
- The audit log has `sign_in.limited` for a link request over the limit, `sign_in.link_sent`, `sign_in.link_used` and `sign_in.link_refused`. It no longer has `sign_in.failed`.

## 0.3.7 (2026-11-08)

The first release from the public repository, with the changes listed under 0.3.6. Follow the upgrade steps in `docs/self-hosting.md`; nothing else is needed.

- The release check upgrades from the releases tagged in this repository. The 0.3.6 tag published no image, because that check looked for an older tag that only the private history has.

## 0.3.6 (2026-11-08, not published)

- `chat workspaces` prints the state that the API and the widget act on: `active`, `suspended`, `read_only`, `waiting_payment` or `waiting_cloud`. It used to print `active` for a workspace that was waiting for payment or read-only.
- The image is public at `ghcr.io/dinghy-chat/dinghy`, so an install needs no registry login.

## 0.3.5 (2026-11-08)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed: the first start writes a Valkey password, existing operator accounts count as confirmed, and existing visitors keep their chats. On a server with a mail server, new accounts from an invite now confirm their email before they sign in.

- Each container now keeps at most 3 log files of 10 MB. Containers created before pick this up when they are recreated, which an upgrade does.
- `chat backup` refuses to start, with a clear message, unless twice the backup's size is free, because Postgres stops when the disk is full.
- The new optional `BACKUP_HEARTBEAT_URL` setting: `chat backup` pings it after each backup that worked, so a monitor such as a healthchecks.io check can tell you when a night has none.
- `chat migrate` prints the path of the backup it takes before migrating. "Going back" in `docs/self-hosting.md` says how to return to the previous release with it, and the new `docs/runbooks.md` covers a full disk, Postgres or Valkey down, mail failing and a bad release.
- A passing `/healthz` or `/readyz` no longer writes a request log line.
- `chat workspaces` lists each workspace's ID, public key, state and name, and `chat setup` prints the ID of the workspace it creates. The export and suspend commands take that ID. `docs/self-hosting.md` has the steps to move a workspace to another server.
- The operator app has PNG, maskable and Apple touch icons, so it looks right when added to a phone's home screen. A new version of its service worker takes over at once instead of waiting for every tab to close.
- `widget.js` carries Preact's license notice. The image no longer ships React and Preact, which only the bundles need, so it is about 9 MB smaller.
- The installer no longer suggests `docker login` when a start fails.
- New docs: `docs/architecture.md` and `docs/api.md`.
- `/readyz` answers 200 whenever Postgres answers. A Valkey outage now shows as `"valkey":"failed"` in its body instead of a 503, because chat keeps working without Valkey, so a proxy keeps sending traffic. The body also has `"worker"`: `ok`, `stale` when no worker finished a pass in 5 minutes, or `none`. `/metrics` has `dinghy_worker_last_pass_timestamp_seconds`.
- A failing worker step no longer skips the steps after it.
- An owner or admin can remove a member and revoke an invite while the workspace is read-only or suspended. A message that waited for the workspace to become read-only is refused, as one that waited for a suspension already was.
- The widget says "This chat is not available on this site." when a workspace stops serving it during a visit, and "Not saved. Try again." when saving an email fails for a reason other than the address. The operator app names a read-only, suspended or rate-limited refusal, and a failed load no longer stays on Loading.
- `chat setup` and `chat create-operator` refuse an unknown flag or a flag with no value. `chat setup` creates its workspace and owner in one transaction.
- On Dinghy Cloud, signup answers 409 `email_taken` only for a wrong password, and any other failure is logged.
- Valkey now needs a password. `init` writes it on the first start after the upgrade, and the app reads it from its secrets, so there is nothing to do. Every container also runs with `no-new-privileges` and without the Linux capabilities it does not need. See "What each container holds" in `docs/self-hosting.md`.
- On a server with a mail server, someone who joins by invite, or signs up on the cloud, confirms their email from a link before they can sign in. Accounts from before the upgrade count as confirmed. Without a mail server, nothing changes. Cloud signup no longer tells whether an email has an account: a known email with another password gets the same answer as a new one, and its owner gets an email about it.
- The app sends `Strict-Transport-Security` when `PUBLIC_URL` is `https://`, and so does the bundled Caddy. Operator API answers carry `Cache-Control: no-store`.
- `chat restore` loads the database dump without administrator rights, and restores only the secrets a backup writes.
- Sign-in has a limit per account across addresses, 200 tries in 15 minutes, next to the one per address. A password reset clears it.
- An anonymous visitor's browser token stops working after a year without use. Each use renews it, and existing visitors get a year from the upgrade.
- Image uploads are checked from their first bytes, and only PNG, JPEG and WebP reach the image decoder.
- A host token's `email` must be one address. Anything else, such as a list, is dropped.
- The app writes one `audit` log line for each failed sign-in, role change, member removal, origin change, signing secret rotation and invite, with IDs and no email.
- API: `POST /v1/invites/join` and `POST /v1/signup` answer with a `verify` field. With `true`, the account signs in from the link in its email.

## 0.3.4 (2026-11-08)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed: a self-hosted install has no plan limits, and behaves as before.

- `chat suspend <workspace-id> [reason]` and `chat unsuspend <workspace-id>` suspend a workspace and lift it. A suspended workspace cannot send or upload, its widget serves nothing, its open chats close, and its operators see a banner. Run them on the `migrate` service, which now has `VALKEY_URL` so that open chats close at once.
- The new optional `IMAGES_ORIGIN` setting serves images from a separate origin, such as `https://files.example.com`. Image links use it, and only it serves images. Images now go out only as PNG, JPEG or WebP. See "A separate origin for images" in `docs/self-hosting.md`.
- Dinghy Cloud has its plan's limits: 5 operators and 1 GB of images per workspace, and a cap on open connections. Images on the cloud are deleted after 12 months, and the message then reads "Image removed after 12 months". Settings shows the plan's use on the cloud. This code is in `ee/`, and stays off on a self-hosted install.
- API: messages have an `imageRemoved` field. `GET /v1/operator/me` has `suspended` on each workspace and a `contact` field. The settings have a `usage` field, null with no limits. A write to a suspended workspace answers 403 with the code `suspended`. On the cloud, an invite or a join past the operator limit answers 409 with `operator_limit`, an image past the storage limit answers 507 with `storage_full`, and a stream past the cap answers 429 with `too_many_streams`.

## 0.3.3 (2026-11-08)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed.

- Dinghy is now open core. The code that only Dinghy Cloud runs, its Stripe billing and cloud signup, moved to `ee/`, under a source-available license (`ee/LICENSE`). Everything else stays AGPL, and the widget stays MIT. `LICENSE-NOTICE.md` explains the split. A self-hosted install keeps every feature and needs no change. The image ships `ee/`, and a self-hosted install never turns it on: the cloud's code stays inactive unless its settings are set, and `ee/LICENSE` allows running it that way in production.
- Contributions now come under a contributor license agreement (`CLA.md`) instead of the DCO. A bot asks first-time contributors to sign it on their pull request.
- The delete route's 502 answer is now described as "The subscription could not be canceled" in `openapi.json`.

## 0.3.2 (2026-11-08)

Follow the upgrade steps in `docs/self-hosting.md`. A migration runs, and nothing else is needed.

- Cloud signup is shorter: `/signup` asks only for an email and a password. The next screen asks for your name and the workspace name, then opens the workspace, or Stripe Checkout once billing is on. A signed-in account with no workspace sees that screen at its next sign-in, on a server where cloud signup is on. A self-hosted install still shows "You are not in a workspace yet".
- `POST /v1/signup` now takes only `email` and `password`, and creates no workspace. The new `POST /v1/operator/workspaces` takes `name` and `workspaceName`, and exists only where cloud signup is on. One account can create 5 workspaces a day.
- An existing account can still sign up again with its own password to add a workspace.
- An account that accepts an invite before it finished onboarding is asked for its name first.
- `chat signups` does not list an account that has not created its workspace yet.

## 0.3.1 (2026-11-07)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed.

- The image takes Alpine's latest security fixes, including zlib's fix for CVE-2026-4738. The 0.3.0 image was never published, because its scan found that flaw.

## 0.3.0 (2026-11-07)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed.

- The operator app, the chat widget and the email stop page have a new look, with a vector boat and self-hosted fonts. The app and the widget no longer switch to dark mode.
- Settings and Alerts open as pages beside the sidebar, so the sidebar stays usable.
- The operator app's address now also serves its two font files, and its content security policy allows them.
- The cloud plan's signup and Stripe billing, which stay off unless the three `STRIPE_*` settings are set. A self-hosted install has no billing, and its workspaces work as before.
- The operator app shows who sent each reply: the teammate's name above their messages, and "You" above your own. Visitors still see no names.
- Signed-out visitors get a short code from their ID, such as "Visitor 7F3K", in place of "Signed-out visitor", so two of them can be told apart.
- A new conversation records the page where the visitor started it, as its address without the query string or the part after `#`. The thread shows it as "Started on". The widget reports the page, so this works once visitors load the new widget.
- Settings has a "Your account" section, where you change your name and your password. A password change signs you out on every other device.
- A conversation whose newest message is from the visitor shows "Waits for a reply" in the list. The Open item and the tab title show how many wait, such as "(3) Dinghy", and both update live.
- A widget message that gets no answer in 30 seconds, or an image in 5 minutes, turns into "not sent" with a retry, and no longer stays at "Sending" for good.
- Close, Reopen, Assign, Block and Unblock now say so when they fail.
- A reply you started stays when you open another conversation and come back, until you reload the page.
- Live streams send `X-Accel-Buffering: no`, so nginx in front of Dinghy does not hold messages back. [Behind your own reverse proxy](docs/self-hosting.md#behind-your-own-reverse-proxy) has the rest of what a proxy needs, and `PUBLIC_URL` is now documented.
- The nightly backup that `install.sh` adds writes its output, and a line with `FAILED` when it fails, to the system log as `dinghy-backup`. Before, its output was thrown away. Run `sudo ./install.sh` again to replace an existing line. If the server runs no cron, the installer now says that it added no backup.
- A first guide for Coolify and Dokploy, which we have not tested on those platforms.
- An owner can delete a workspace in Settings by typing its name. Its data and images are deleted within minutes. See [Deleting a workspace](docs/self-hosting.md#deleting-a-workspace).
- On the cloud plan, a subscription that ends or a payment that fails for 14 days makes the workspace read-only for 30 days, and it is deleted after that. The owners get an email at each step, and Settings has a Billing section with Stripe's portal. A self-hosted install has no billing, so none of this applies to it.
- Early cloud signups, for Dinghy's own cloud before it takes payments. With `CLOUD_SIGNUP=early` and no Stripe keys, anyone can sign up with no payment step and use the whole dashboard, with a banner saying the cloud opens soon. The widget stays off and Settings shows no install code until the workspace is paid for. A new account gets a sample conversation and a welcome email. `chat signups` lists the waiting owners as CSV. With Stripe keys set, the banner offers Checkout instead. A self-hosted install leaves the setting unset and has no signup, as before.
- `/v1/meta` has a `signup` field, and each workspace in `/v1/operator/me` has a `waiting` field.

## 0.2.1 (2026-11-06)

Follow the upgrade steps in `docs/self-hosting.md`. Nothing else is needed.

- `install.sh` installs Dinghy with one command. It installs Docker if it is missing, gets a certificate, creates the owner and adds a nightly backup.
- With no mail server, the widget no longer asks for an email, because it could not send the reply.
- The docs now cover adding the chat to a site, the operator app, every setting and troubleshooting.

## 0.2.0 (2026-11-06)

Follow the upgrade steps in `docs/self-hosting.md`. A migration takes a backup first.

- `chat backup` now holds the database, the local images and the app's secrets, in one file.
- `chat restore` restores it, also on a clean host. If it fails, the old data stays.
- A backup can upload a copy to any S3 bucket, encrypted to a key that the server does not hold.
- `scripts/upgrade-postgres.sh` moves the data to a new Postgres major version.
- A data directory from a newer release stops with a clear error.
- An export no longer cuts archive names longer than 100 bytes. This fixes images in a workspace that came from `chat import`.
- The image no longer holds npm or corepack, which the server does not use.

## 0.1.0 (2026-11-06)

The first release, for private testing. It has chat with images, the operator app, several operators, alerts, tenant isolation, export and import, and the one-file install.
