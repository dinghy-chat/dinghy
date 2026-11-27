---
title: A lightweight self-hosted Chatwoot alternative | Dinghy
nav: Dinghy vs Chatwoot
description: Compare Dinghy and Chatwoot for self-hosted website chat. See what each runs, which channels it supports, and how to try Dinghy.
date: 2026-11-08
updated: 2026-11-27
priceChecked: 2026-11-22
order: 6
card: Website chat, self-hosting and other support channels
stat: $19/agent
---

# A lightweight self-hosted Chatwoot alternative

Dinghy gives a small team a website chat widget and a shared inbox. Use Chatwoot if your team needs email and WhatsApp in the same inbox, a help center, or a built-in AI assistant.

## Which one fits

Dinghy runs as one application process with Postgres and Valkey. In our [load test](/blog/one-small-server), the full install peaked at 539 MB with 5,000 open connections on one 4 GB server. Chatwoot's server figures below come from its deployment docs.

[Try the Dinghy chat](/#features) or [install it on a Linux server](/docs/self-hosting).

## Self-hosting

| | Dinghy | Chatwoot |
|---|---|---|
| What runs | One Node app, Postgres, Valkey | Rails app, Sidekiq workers, Postgres, Redis |
| Server size | Ran on 2 vCPUs and 4 GB in our load test, peak 539 MB | 4 GB minimum, 4 cores recommended in its docs |
| Install | One script on a fresh Linux server | Docker, Linux script, Kubernetes and more |
| License | AGPL 3.0, widget MIT, cloud billing in `ee/` under a source-available license | MIT, with an `enterprise/` folder under its own license |
| Paid features when self-hosted | None | Some |

Chatwoot publishes its [server requirements](https://www.chatwoot.com/docs/self-hosted/deployment/requirements/) and [license](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE). See [Dinghy's measurements](/docs/measurements) for the workload, timings and test limits.

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

Keep access to your Chatwoot history. Dinghy starts with an empty inbox.

1. Set up Dinghy on a test page. Add that page's origin in **Settings > Install**.
2. Send a test message from the widget. Reply from the shared inbox and check the visitor receives it.
3. Add your production site's origin. Replace the Chatwoot widget tag with the Dinghy tag when your team is ready to switch.

Keep the previous widget tag handy so you can restore it if necessary. See [how to add the chat to your website](/docs/add-to-your-site).
