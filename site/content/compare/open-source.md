---
title: Open-source live chat: the options in 2026 | Dinghy
nav: Open-source options
description: The open-source live chats you can self-host in 2026, with their licenses, the server each one needs per its docs, and who it's for.
date: 2026-11-09
updated: 2026-11-14
order: 1
card: Seven self-hosted chats, their licenses and server needs
stat: 7 projects
---

# Open-source live chat options in 2026

I compared them for a small team that only needs website chat.

I make Dinghy, so keep that in mind when you see where I put it. I checked every license and the last commit on GitHub on November 9, 2026, and took server sizes from each project's own docs.

## The quick answer

If you only want website chat, look at Dinghy or Live Helper Chat. If you want one inbox for chat, email, WhatsApp and more, go with Chatwoot. If you already run Zammad or Rocket.Chat, their chat widget may be enough. Papercups isn't maintained anymore.

## At a glance

| Project | License | What it is | Server needs, from its docs | Last commit |
|---|---|---|---|---|
| Dinghy | AGPL 3.0, widget MIT | Website chat and a shared inbox, with your own AI agent through MCP | Measured on 2 vCPUs and 4 GB, peak 539 MB | November 2026 |
| Live Helper Chat | Apache 2.0 | Website chat with bots, voice, video and other channels | PHP 8.2, MySQL 5.7 or MariaDB. No memory figure given | November 2026 |
| Chatwoot | MIT, plus an `enterprise/` folder under its own license | Inbox for chat, email, WhatsApp and more | 4 GB minimum, 4 cores recommended | November 2026 |
| Tiledesk | MIT | Chatbot builder with handoff to humans | Nine services plus MongoDB. No size given | November 2026 |
| Zammad | AGPL 3.0 | Help desk with a chat channel | 2 cores and 6 GB, plus 4 GB for Elasticsearch | November 2026 |
| Rocket.Chat | MIT, plus an `ee/` folder under its own license | Team chat with an omnichannel livechat | 2 vCPUs and 4 GB, plus MongoDB | November 2026 |
| Papercups | MIT | Website chat, now unmaintained | Elixir app. No size given | May 2022 |

## Dinghy

Dinghy is a live chat widget and a shared inbox. No built-in bot, no email inbox channel, no help center. It does have saved replies, notes, labels, files, business hours, analytics, an API, webhooks and an MCP server. Your own AI agent can connect and draft replies, and a person sends them. A reply to a visitor who left goes out by email. The operator app installs on your phone and sends push alerts.

It's one Docker image with Postgres and Valkey, and one script installs it on a fresh Linux server. We ran the full install on a Hetzner CX23 with 2 vCPUs and 4 GB. With 5,000 open chat connections it peaked at 539 MB of memory. Every number is on the [measurements page](/docs/measurements). The self-hosted version has every feature, and there's no license check.

It's not for you if you want a bot builder, a ready-made AI agent or other channels. Hosted, it's $7 a month for up to 5 people. More on the [open-source live chat page](/open-source-live-chat).

## Live Helper Chat

Live Helper Chat is a PHP project with commits and releases every week or so. It does website chat, bots that connect to AI services, voice, video, screen sharing, co-browsing, Telegram, Messenger and WhatsApp. Its site says unlimited operators and departments, and there's paid hosting too.

It needs PHP 8.2 or later with MySQL 5.7 or MariaDB 10.2.3, behind Apache or Nginx, and there's an official Docker setup. The install guide doesn't give a memory figure.

## Chatwoot

Chatwoot is a popular open-source Intercom alternative. One inbox for website chat, email, WhatsApp, Facebook, Telegram and more, plus a help center, automation and an AI assistant. It's a Rails app with Sidekiq workers, Postgres and Redis. Its docs ask for at least 4 GB of memory and recommend 4 cores.

The self-hosted code is MIT, except an `enterprise/` folder with its own license, so some features are paid. Chatwoot Cloud has a free plan for 2 agents and 500 conversations a month.

See [Dinghy vs Chatwoot](/compare/chatwoot).

## Tiledesk

Tiledesk is mostly a platform for building chatbots, AI ones included, that hand the chat to a human when needed. The chat widget and agent dashboard come with it. Its README lists nine components, like the server, the dashboard, the chatbot design studio, chat servers and MongoDB. It says Docker Compose is for development and trials, and Kubernetes with Helm is for production.

## Zammad

Zammad is an open-source help desk for tickets and email, with a chat channel and an embeddable widget. The widget only shows up when an agent is online and has room for another chat. Its docs ask for 2 CPU cores and 6 GB of memory, plus 4 GB more if Elasticsearch runs on the same server.

## Rocket.Chat

Rocket.Chat is team chat, like a self-hosted Slack, with an omnichannel module that puts a livechat widget on your website. The free Starter plan covers up to 50 users, with usage limits on premium features. For a small install, its docs list 2 vCPUs and 4 GiB for the server, and a separate MongoDB with its own 2 vCPUs and 4 GiB.

It's for a company that already runs Rocket.Chat for its own team.

## Papercups

Papercups was an Elixir live chat with Slack replies. It went into maintenance mode in January 2022, and the last commit is from May 2022. Its website returns an error now. You can still run the MIT code, but nobody ships fixes. [What to use instead of Papercups](/compare/papercups).

## Others we looked at

Chaskiq is an Intercom-style messenger with its code on GitHub. But its license adds the Commons Clause to the AGPL, which forbids selling it as a service, so it's not open source in the usual sense. Its last commit was in June 2026, after a gap of more than a year.

## How to choose

Start with what you need besides chat. If you need email and other channels, go with Chatwoot or Zammad. If you want a bot to answer first, look at Tiledesk or Live Helper Chat. Then check the server size against what you're willing to pay for and keep updated.

To compare hosted prices instead, see [what live chat costs for 1, 3 and 5 people](/compare/).
