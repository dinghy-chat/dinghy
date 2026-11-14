---
title: Open-source live chat: the options in 2026 | Dinghy
nav: Open-source options
description: The open-source live chats you can self-host in 2026, with licenses, server needs from each project's docs, and who each one fits.
date: 2026-11-09
updated: 2026-11-14
order: 1
card: Seven self-hosted chats, their licenses and server needs
stat: 7 projects
---

# Open-source live chat options in 2026

There are more open-source live chats than you'd think, but most of them grew into help desks or chatbot platforms. This page sorts them by one question. How well does it fit a small team that only wants a chat on its website?

We make Dinghy, so read our placement with that in mind. We checked every license and the last commit on GitHub on November 9, 2026, and took server sizes from each project's own docs.

## The quick answer

If you only want website chat, look at Dinghy or Live Helper Chat. If you want one inbox for chat, email, WhatsApp and more, Chatwoot is the strong pick. If you already run Zammad or Rocket.Chat, their chat widget may be enough. Papercups is no longer maintained.

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

Dinghy is a live chat widget and a shared inbox. It has no built-in bot, no email inbox channel and no help center. It does have saved replies, notes, labels, files, business hours, analytics, an API, webhooks and an MCP server. Your own AI agent can connect and draft replies, which a person sends. A reply to a visitor who left goes by email. The operator app installs on your phone and sends push alerts.

It's one Docker image with Postgres and Valkey, installed by one script on a fresh Linux server. We ran the full install on a Hetzner CX23 with 2 vCPUs and 4 GB. With 5,000 open chat connections it peaked at 539 MB of memory. Every number is on the [measurements page](/docs/measurements). The self-hosted version has every feature, and there's no license check.

Fits a small team that wants website chat and as little to run as possible. Doesn't fit if you want a bot builder, a ready-made AI agent or other channels. Hosted, it's $7 a month for up to 5 people. More on the [open-source live chat page](/open-source-live-chat).

## Live Helper Chat

Live Helper Chat is a PHP project with commits and releases every week or so. It's focused on website chat, and it piles on features, with bots that can connect to AI services, voice, video and screen sharing, co-browsing, and channels like Telegram, Messenger and WhatsApp. Its site says it has unlimited operators and departments, and it offers paid hosting too.

It runs on PHP 8.2 or later with MySQL 5.7 or MariaDB 10.2.3, behind Apache or Nginx, and has an official Docker setup. Its install guide doesn't give a memory figure.

Fits a team that wants a chat-first tool with lots of options and is comfortable with a PHP and MySQL stack.

## Chatwoot

Chatwoot is a popular open-source alternative to Intercom. One inbox for website chat, email, WhatsApp, Facebook, Telegram and more, with a help center, automation and an AI assistant. It's a Rails app with Sidekiq workers, Postgres and Redis. Its docs ask for at least 4 GB of memory and recommend 4 cores.

The self-hosted code is MIT, except an `enterprise/` folder with its own license, so some features are paid. Chatwoot Cloud has a free plan for 2 agents and 500 conversations a month.

Fits a team that wants many channels in one place. For website chat alone, it's more than you need. Here's [Dinghy vs Chatwoot](/compare/chatwoot).

## Tiledesk

Tiledesk is mostly a platform for building chatbots, including AI ones, that hand the conversation to a human when needed. The chat widget and agent dashboard are part of it. Its README lists nine components, among them the server, dashboard, chatbot design studio, chat servers and MongoDB. It says Docker Compose is for development and trials, and Kubernetes with Helm for production.

Fits a team whose main goal is a chatbot, with people as the backup.

## Zammad

Zammad is an open-source help desk for tickets and email, and it has a chat channel with an embeddable widget. The widget only shows up when an agent is online and has room for another chat. Its docs ask for 2 CPU cores and 6 GB of memory, plus 4 GB more if Elasticsearch runs on the same server.

Fits a team that wants a full help desk and treats chat as one way in. Heavy if chat is all you want.

## Rocket.Chat

Rocket.Chat is a team chat platform, like a self-hosted Slack, with an omnichannel module that puts a livechat widget on your website. Its free Starter plan covers up to 50 users, with usage limits on premium features. For a small install, its docs list 2 vCPUs and 4 GiB for the server and a separate MongoDB with its own 2 vCPUs and 4 GiB.

Fits a company that already runs Rocket.Chat for its own team. A lot to set up only for website chat.

## Papercups

Papercups was a neat Elixir live chat with Slack replies. It went into maintenance mode in January 2022, and its last commit is from May 2022. Its website now returns an error. You can still run the MIT code, but nobody ships fixes. [What to use instead of Papercups](/compare/papercups).

## Others we looked at

Chaskiq is an Intercom-style messenger with its code on GitHub, but its license adds the Commons Clause to the AGPL, which forbids selling it as a service, so it isn't open source in the usual sense. Its last commit was in June 2026, after a gap of more than a year.

## How to choose

Start with what you need besides chat. If the answer is nothing, pick the smallest thing to run. If you need email and other channels, Chatwoot or Zammad will serve you better. If you want a bot to answer first, look at Tiledesk or Live Helper Chat. Then check the server size against what you're willing to pay for and keep updated.

If you'd rather compare hosted prices, see [what live chat costs for 1, 3 and 5 people](/compare/).
