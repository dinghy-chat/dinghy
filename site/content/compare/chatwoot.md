---
title: Chatwoot alternative, lighter to self-host: Dinghy vs Chatwoot | Dinghy
nav: Dinghy vs Chatwoot
description: Both are open-source live chats you can self-host. Chatwoot does every channel and wants 4 GB of RAM. Dinghy does website chat and nothing else.
date: 2026-11-08
updated: 2026-11-14
order: 6
card: Both open source. Chatwoot does every channel, Dinghy does chat
stat: $19/agent
---

# Dinghy vs Chatwoot

Chatwoot is an open-source Intercom alternative. Live chat, email, WhatsApp and more, plus a help center and AI. It's website chat and a team inbox, and it emails your reply to visitors who already left. No other channels.

## The quick answer

Use Chatwoot for multiple channels, a help center, automation rules or a built-in AI assistant. To self-host it, you'll run a Rails app with background workers. For website chat, Dinghy runs as one app with Postgres and Valkey on a small server.

## Self-hosting

| | Dinghy | Chatwoot |
|---|---|---|
| What runs | One Node app, Postgres, Valkey | Rails app, Sidekiq workers, Postgres, Redis |
| Server size | Ran on 2 vCPUs and 4 GB in our load test, peak 539 MB | 4 GB minimum, 4 cores recommended in its docs |
| Install | One script on a fresh Linux server | Docker, Linux script, Kubernetes and more |
| License | AGPL 3.0, widget MIT, cloud billing in `ee/` under a source-available license | MIT, with an `enterprise/` folder under its own license |
| Paid features when self-hosted | None | Some |

I took the Chatwoot details from its self-hosting docs and its GitHub license on November 8, 2026. The Dinghy number is from [our load test](/docs/measurements): one Hetzner CX23 ran the full install with 5,000 open chat connections in under 600 MB.

## Hosted plans

| | Dinghy Cloud | Chatwoot Cloud |
|---|---|---|
| Free plan | No | Hacker, 2 agents, 500 conversations a month, 30 days of history |
| 3 people | $7 a month | $57 a month on Startups |
| 5 people | $7 a month | $95 a month on Startups |
| Channels | Website chat, and replies by email to visitors who left | Website chat, email, WhatsApp and more |
| AI | None built in. Your own agent connects through MCP or the API, and its replies wait as drafts | Captain, its AI assistant |

[All the prices side by side](/compare/).

## What Chatwoot does that Dinghy doesn't

- Lots of channels in one inbox: email, WhatsApp, Facebook, Telegram.
- A help center and automation rules.
- Captain, a built-in AI assistant.
- Native mobile apps. Dinghy's operator app is a web app you install on your phone, with push alerts.

## What Dinghy does differently

One app container, Postgres and Valkey. You get every feature when you self-host.

No built-in AI, no extra channels. The inbox has saved replies, notes with @mentions, labels, files, business hours, analytics, and an API with webhooks. Connect your own agent through MCP or the API. Its replies wait as drafts until a person sends them, see [Bring your own AI agent](/blog/bring-your-own-ai-agent). The widget loader is under 4 KB, and the rest only loads when someone opens the chat. If you don't want to run a server, Dinghy Cloud is $7 a month for up to 5 people.

## Moving over

There's no importer from Chatwoot. To self-host, run the script in the [self-hosting guide](/docs/self-hosting). The steps are in [Moving over from another chat](/compare/#moving-over-from-another-chat).
