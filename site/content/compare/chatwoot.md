---
title: Lighter Chatwoot alternative: Dinghy vs Chatwoot
nav: Dinghy vs Chatwoot
description: Compare Dinghy and Chatwoot for self-hosted chat: server requirements, channels, campaigns, AI and the cost for a small team.
date: 2026-11-08
updated: 2026-11-22
priceChecked: 2026-11-22
order: 6
card: Website chat, self-hosting and other support channels
stat: $19/agent
---

# Dinghy vs Chatwoot

Chatwoot is an open-source Intercom alternative. Live chat, email, WhatsApp and more, plus a help center and AI. Dinghy is website chat and a team inbox, and it emails your reply to visitors who already left. No other channels.

## Which one fits

Use Chatwoot for multiple channels, a help center, automation rules or a built-in AI assistant. To self-host it, you'll run a Rails app with background workers. For website chat, Dinghy runs as one app with Postgres and Valkey on a small server.

## Self-hosting

| | Dinghy | Chatwoot |
|---|---|---|
| What runs | One Node app, Postgres, Valkey | Rails app, Sidekiq workers, Postgres, Redis |
| Server size | Ran on 2 vCPUs and 4 GB in our load test, peak 539 MB | 4 GB minimum, 4 cores recommended in its docs |
| Install | One script on a fresh Linux server | Docker, Linux script, Kubernetes and more |
| License | AGPL 3.0, widget MIT, cloud billing in `ee/` under a source-available license | MIT, with an `enterprise/` folder under its own license |
| Paid features when self-hosted | None | Some |

Chatwoot publishes its [server requirements](https://www.chatwoot.com/docs/self-hosted/deployment/requirements/) and [license](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE). The Dinghy number is from [our load test](/docs/measurements): one Hetzner CX23 ran the full install with 5,000 open chat connections in under 600 MB.

## Hosted plans

| | Dinghy Cloud | Chatwoot Cloud |
|---|---|---|
| Free plan | No | Hacker, 2 agents, 500 conversations a month, 30 days of history |
| 3 people | $9 a month | $57 a month on Startups |
| 5 people | $9 a month | $95 a month on Startups |
| Channels | Website chat, and replies by email to visitors who left | Website chat, email, WhatsApp and more |
| AI | None built in. Your own agent connects through MCP or the API, and its replies wait as drafts | Captain, its AI assistant |

See [Chatwoot’s pricing page](https://www.chatwoot.com/pricing/) or [all prices side by side](/compare/).

## What Chatwoot does that Dinghy doesn't

- Lots of channels in one inbox: email, WhatsApp, Facebook, Telegram.
- A help center and automation rules.
- Captain, a built-in AI assistant.
- Native mobile apps. You can install Dinghy's web app on your phone and turn on [browser notifications](/docs/operator-guide#get-alerts).

## What Dinghy does differently

You get a shared inbox with saved replies, labels and [campaigns](/blog/proactive-live-chat), even when you self-host. If you want AI to help with replies, [connect your own agent](/blog/bring-your-own-ai-agent). It starts by drafting replies for your team.

## Moving over

Dinghy can’t import Chatwoot conversations. [Switch your site to Dinghy](/compare/#moving-over-from-another-chat).
