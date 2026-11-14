---
title: Chatwoot alternative that's lighter to self-host: Dinghy vs Chatwoot | Dinghy
nav: Dinghy vs Chatwoot
description: Chatwoot and Dinghy are both open-source live chats you can self-host. Chatwoot covers every channel and asks for 4 GB. Dinghy does website chat only.
date: 2026-11-08
updated: 2026-11-14
order: 6
card: Both open source. Chatwoot does every channel, Dinghy does chat
stat: $19/agent
---

# Dinghy vs Chatwoot

Chatwoot is a popular open-source alternative to Intercom. It handles live chat, email, WhatsApp and more, with a help center and AI on top. Dinghy is much smaller. It does website chat and the team inbox, with replies by email to visitors who left, and no other channels.

The choice comes down to how much you want to run.

## The quick answer

Pick Chatwoot if you want one inbox for many channels, a help center, automation rules or a built-in AI assistant, and you're fine running a Rails app with background workers. Pick Dinghy if website chat is all you need and you want a single app with Postgres and Valkey on a small server.

## Self-hosting

| | Dinghy | Chatwoot |
|---|---|---|
| What runs | One Node app, Postgres, Valkey | Rails app, Sidekiq workers, Postgres, Redis |
| Server size | Ran on 2 vCPUs and 4 GB in our load test, peak 539 MB | 4 GB minimum, 4 cores recommended in its docs |
| Install | One script on a fresh Linux server | Docker, Linux script, Kubernetes and more |
| License | AGPL 3.0, widget MIT, cloud billing in `ee/` under a source-available license | MIT, with an `enterprise/` folder under its own license |
| Paid features when self-hosted | None | Some |

The Chatwoot details are from its self-hosting docs and its GitHub license on November 8, 2026. The Dinghy server size comes from [our load test](/docs/measurements): one Hetzner CX23 ran the full install with 5,000 open chat connections in under 600 MB.

## Hosted plans

| | Dinghy Cloud | Chatwoot Cloud |
|---|---|---|
| Free plan | No | Hacker, 2 agents, 500 conversations a month, 30 days of history |
| 3 people | $7 a month | $57 a month on Startups |
| 5 people | $7 a month | $95 a month on Startups |
| Channels | Website chat, with replies by email to visitors who left | Website chat, email, WhatsApp and more |
| AI | None built in. Your own agent connects through MCP or the API, and its replies wait as drafts | Captain, its AI assistant |

[All the prices side by side](/compare/).

## What Chatwoot does that Dinghy doesn't

- Many channels in one inbox, like email, WhatsApp, Facebook and Telegram.
- A help center and automation rules.
- Captain, its AI assistant, built in.
- Native mobile apps. Dinghy's operator app is a web app you can install on your phone, with push alerts.

## What Dinghy does differently

Dinghy has fewer moving parts. It's one app container with Postgres and Valkey, and the self-hosted install has every feature, with nothing held back for a paid edition.

It also does less, on purpose. No built-in AI and no extra channels, just a chat between your visitors and your team. The inbox still has what a small team uses every day: saved replies, notes with @mentions, labels, files, business hours, analytics, and an API with webhooks. If you want a bot, connect your own agent through MCP or the API. Its replies wait as drafts for a person to send, as [Bring your own AI agent](/blog/bring-your-own-ai-agent) explains. The widget's loader is under 4 KB, and the rest loads only when someone opens the chat. If you'd rather not run a server, Dinghy Cloud is $7 a month for up to 5 people.

## Moving over

There's no importer from Chatwoot. If you self-host, the [self-hosting guide](/docs/self-hosting) installs Dinghy with one script. [Moving over from another chat](/compare/#moving-over-from-another-chat) has the steps.
