---
title: Leaving the cloud: move your chat to your own server
nav: Move to your own server
description: A Dinghy Cloud workspace exports to one file that imports into a self-hosted Dinghy. The whole move, step by step, and what changes on your site.
date: 2026-11-09
updated: 2026-11-14
order: 5
card: One export file, one import command, and you're out
---

# Leaving the cloud: move your chat to your own server

Before you hand your customer chats to a small company, ask how you'd get them back. With Dinghy it's one file.

Dinghy Cloud runs the same code you can run yourself. An owner downloads the workspace as one file, with every conversation, visitor, teammate, setting and image in it. That file imports into Dinghy on your own server. The [self-hosting guide](/docs/self-hosting#moving-a-workspace) has the short version.

## Set up the new server first

Do this before you export anything. The export is a snapshot, so chats that come in after you download it stay on the cloud. Import it as soon as you export it.

Install Dinghy on a Linux server with the install script. It asks for your domain and email, gets an HTTPS certificate and prints a sign-in link. [The self-hosting walkthrough](/blog/self-host-live-chat) goes through it.

Sign up there with the same email you use on the cloud. When the workspace arrives, your account joins it.

## Export, then import

On Dinghy Cloud, an owner opens Settings > Workspace and clicks Download an export. Ask a workspace owner to export it.

Copy the file to your server and run these from the folder with `compose.yaml`:

```sh
docker compose cp -a export.tar app:/tmp/export.tar
docker compose exec app chat import /tmp/export.tar
```

If you run the import twice, it refuses the second one.

## Let your team in

The import lists every teammate who doesn't have an account on the new server yet. If you set up email, they sign in with a link sent to their inbox. If you didn't, make a link for each person:

```sh
docker compose exec app chat sign-in-link teammate@example.com
```

A link works once, for 15 minutes.

## Change one thing on your site

Your chat tag still loads from Dinghy Cloud. Swap the address in it for your new server's domain. The public key and your allowed sites came over with the import, so only the address changes. The new tag is in Settings > Install, with a copy button.

If your site tells Dinghy [who is chatting](/docs/add-to-your-site#show-who-is-chatting), there's one more step. The imported workspace gets a new signing secret, and tokens signed with the old one stop working. Copy the new secret from Settings > Install, under Identify signed-in users, into your site's server config.

## Reconnect your bots and webhooks

API keys arrive revoked, because their tokens never leave the old server. If a bot or an AI agent answers your chats, create a new key in Settings > API & webhooks and give it to the bot. An agent that connected through OAuth, like Claude Code, just connects again. The export doesn't hold webhooks either. Add them again in the same place, and give each receiving app its new signing secret.

## Once it's working

When new chats show up on your server, cancel Dinghy Cloud. You don't lose anything: every feature is in the self-hosted version, and the cloud's limits of 5 people and 1 GB of files don't apply on your own server.

But the server is yours to look after now. Back up the server and install updates. The installer sets up a nightly backup if the server runs cron, but it lands on the same disk. Read [the backups section](/docs/self-hosting#backups) and send a copy somewhere else before you cancel.

The same file works between any two Dinghy servers. To move to a bigger machine or another host later, follow the same steps. Use `chat export` on the old server instead of the button.
