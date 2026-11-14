---
title: Live chat for agencies and freelancers | Dinghy
nav: Agencies
description: Set up live chat for client sites with one Dinghy workspace per client and one login for all of them. $7 a month per client on Dinghy Cloud.
date: 2026-11-09
updated: 2026-11-14
order: 4
card: One workspace per client, $7 each or self-hosted
---

# Live chat for agencies and freelancers

If you build sites for clients, Dinghy lets you give each client their own chat and inbox, and still reach all of them from one login. Each client is a workspace. On Dinghy Cloud, each workspace is $7 a month, flat, for up to 5 people, so the client's team fits in it too.

## One workspace per client

A workspace has its own inbox, team, widget tag, allowed sites and signing secret. Clients never see each other's chats.

1. Sign up on Dinghy Cloud and create the first client's workspace.
2. For the next client, open the workspace menu at the top of the sidebar and select Create a workspace. Each one has its own $7 subscription.
3. Paste each workspace's tag on that client's site, from Settings > Install, and add the client's domain under Allowed sites on the same page.
4. Set the client's colors, chat button and words in Settings > Appearance, with no code, and their logo in Settings > Workspace.

A coding agent such as Claude Code or Cursor can do steps 3 and 4 for you. Connect it to the client's workspace with Full access, and it adds the tag, the allowed site and the colors, then checks the install. [Use Dinghy with AI agents](/docs/agents#set-up-the-chat-on-a-site) has the steps.

The workspace menu at the top of the sidebar switches between clients. Your login is the same everywhere.

## Who owns what

You can run it two ways, and both work with the roles Dinghy has.

**You own it.** You create the workspace, pay for it, and invite the client's staff as agents or admins. That suits a client who wants chat as part of a care plan you bill for.

**The client owns it.** The client signs up, pays, and invites you as an admin. You set up the tag, the colors and the allowed sites, and they keep the account if you part ways. An owner can always download an export of the whole workspace.

Agents answer, assign, close and block. Admins also change settings and invite agents. Owners also invite admins, change roles and download exports. The [operator guide](/docs/operator-guide#set-up-your-team) has the full table.

## Self-hosting for clients

Dinghy is open source, and its license lets you host it for others with no agreement and no fee, as long as the cloud billing features stay off. Every product feature is in the self-hosted version. If you change the server code, the AGPL requires you to offer the changed source to the people who use it.

The catch is that a self-hosted install starts with one workspace. Its setup command creates one and runs once, and Create a workspace in the menu is a Dinghy Cloud feature. The server itself keeps workspaces apart. Every query filters by workspace, and row-level security in Postgres backs that up. The import command can add a workspace exported from another Dinghy server. But there's no button for a fresh second workspace on a self-hosted install today.

So if you self-host for clients, plan on one install per client. We measured the install on a 2 vCPU, 4 GB server, and the [measurements page](/docs/measurements) has the numbers. We haven't tested many workspaces on one server. The [self-hosting guide](/docs/self-hosting) has the install, backups and upgrades.

## Handing a client off

If a client moves to their own server later, the owner downloads an export from Settings > Workspace. It holds the conversations, visitors, team, settings, images and files, and it imports into a self-hosted Dinghy. The public key and allowed sites stay the same, so only the script address in the tag changes. [Moving a workspace](/docs/self-hosting#moving-a-workspace) has the steps.

## When Dinghy isn't the right fit

- You want one bill for all your clients. On Dinghy Cloud, each workspace is its own $7 subscription.
- You want to resell chat under your own brand on many clients from one self-hosted server. The self-hosted version doesn't create extra workspaces from the app.
- A client needs more than 5 people answering on the cloud, or a shared email inbox, WhatsApp and social messages in one place. Dinghy is website chat. Replies reach a visitor by email only when they left the chat.
- A client wants a ready-made AI agent trained on their help center, campaigns or a help center. Dinghy has none of these. It has no AI of its own, though the client's own bot can answer through MCP or the API. See [Live chat for AI agents](/for/ai-agents).

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) at $7 a month per client workspace, or [host it yourself](/docs/self-hosting) for free.
