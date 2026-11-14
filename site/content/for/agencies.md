---
title: Live chat for agencies and freelancers | Dinghy
nav: Agencies
description: Live chat for client sites: one Dinghy workspace per client, one login for all of them. $7 a month per client on Dinghy Cloud.
date: 2026-11-09
updated: 2026-11-14
order: 4
card: One workspace per client, $7 each or self-hosted
---

# Live chat for agencies and freelancers

Give each client their own chat and inbox. Use one login to switch between them. Each client is a workspace. On Dinghy Cloud a workspace is $7 a month, flat, for up to 5 people.

## One workspace per client

A workspace has its own inbox, team, widget tag, allowed sites and signing secret. Clients never see each other's chats.

1. Sign up on Dinghy Cloud and create the first client's workspace.
2. For the next client, open the workspace menu at the top of the sidebar and select Create a workspace. Each one has its own $7 subscription.
3. Paste each workspace's tag on that client's site, from Settings > Install, and add the client's domain under Allowed sites on the same page.
4. Set the client's colors, chat button and words in Settings > Appearance, with no code, and their logo in Settings > Workspace.

A coding agent like Claude Code or Cursor can do steps 3 and 4 for you. Connect it to the client's workspace with Full access. It adds the tag, the allowed site and the colors, then checks the install. [Use Dinghy with AI agents](/docs/agents#set-up-the-chat-on-a-site) has the steps.

You switch between clients with the workspace menu at the top of the sidebar. Same login everywhere.

## Who owns what

**You own it.** You create the workspace, pay for it, and invite the client's staff as members or admins. That's good for a client who gets chat as part of a care plan you bill for.

**The client owns it.** The client signs up, pays, and invites you as an admin. You set up the tag, the colors and the allowed sites. If you part ways, they keep the account. An owner can always download an export of the whole workspace.

Members answer, assign, close and block. Admins can also change settings and invite members. Owners can also invite admins, change roles and download exports. The full table is in the [operator guide](/docs/operator-guide#set-up-your-team).

## Self-hosting for clients

Dinghy is open source. Its license lets you host it for other people with no agreement and no fee, as long as the cloud billing features stay off. Every product feature is in the self-hosted version. If you change the server code, the AGPL says you have to offer the changed source to the people who use it.

A self-hosted install starts with one workspace. The setup command creates it and runs once, and Create a workspace in the menu is a Dinghy Cloud feature. Each query filters by workspace. Postgres row-level security adds a second check. And the import command can add a workspace exported from another Dinghy server. You can't create a second workspace from the self-hosted app.

For now, use one self-hosted install per client. We measured the install on a 2 vCPU, 4 GB server, and the numbers are on the [measurements page](/docs/measurements). We haven't tested lots of workspaces on one server. The [self-hosting guide](/docs/self-hosting) covers the install, backups and upgrades.

## Handing a client off

If a client moves to their own server later, the owner downloads an export from Settings > Workspace. It has the conversations, visitors, team, settings, images and files, and it imports into a self-hosted Dinghy. The public key and allowed sites don't change, so the only thing that changes in the tag is the script address. Steps are in [Moving a workspace](/docs/self-hosting#moving-a-workspace).

## When Dinghy isn't the right fit

- You want one bill for all your clients. On Dinghy Cloud, each workspace is its own $7 subscription.
- You want to resell chat under your own brand to many clients from one self-hosted server. The self-hosted version can't create extra workspaces from the app.
- A client needs more than 5 people answering on the cloud, or wants a shared email inbox, WhatsApp and social messages next to the chat. Dinghy is website chat. A reply reaches a visitor by email only when they've left the chat.
- A client wants a ready-made AI agent trained on their help center, or wants campaigns or a help center of their own. Dinghy has none of that. It has no AI of its own, but the client's own bot can answer through MCP or the API. See [Live chat for AI agents](/for/ai-agents).

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) at $7 a month per client workspace, or [host it yourself](/docs/self-hosting) for free.
