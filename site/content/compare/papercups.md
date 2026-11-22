---
title: Papercups alternatives for self-hosted live chat | Dinghy
nav: Papercups alternatives
description: Papercups is in maintenance mode. Compare two maintained options for your site: Chatwoot and Dinghy.
date: 2026-11-09
updated: 2026-11-22
priceChecked: 2026-11-22
order: 11
card: Two maintained options for your site
stat: Maintenance mode
---

# Papercups is in maintenance mode. What to use now

Papercups was an open-source live chat written in Elixir. You could use the hosted version or run it yourself. It went into maintenance mode in January 2022, and the last code change on GitHub is from May 10, 2022.

## Where Papercups stands today

The [Papercups README](https://github.com/papercups-io/papercups) says it is in maintenance mode. You can still run a copy under the MIT license. If you rely on it for customer support, check the project’s recent activity and decide who will maintain your install.

## Which one fits

If you used Papercups for its Slack and Mattermost replies, email or SMS, look at Chatwoot. Chatwoot is still maintained and has a free cloud plan. If you used Papercups only for website chat, Dinghy does that and needs less to run.

## What it costs now

| | Dinghy | Chatwoot | Papercups |
|---|---|---|---|
| Self-hosted | Free, AGPL 3.0, widget MIT | Free, MIT, with an `enterprise/` folder under its own license | Free, MIT, in maintenance mode |
| Hosted, 1 person | $9 a month | $0 on Hacker, or $19 on Startups | No current plan verified |
| Hosted, 3 people | $9 a month | $57 a month on Startups | No current plan verified |
| Hosted, 5 people | $9 a month | $95 a month on Startups | No current plan verified |
| Last code change | November 2026 | November 2026 | May 2022 |

Chatwoot prices are from [Chatwoot’s pricing page](https://www.chatwoot.com/pricing/). The free Hacker plan has 2 agents, 500 conversations a month, live chat only, and 30 days of history. [All the prices side by side](/compare/).

## Chatwoot

Chatwoot is open source. Live chat, email, WhatsApp, Facebook and more in one inbox, plus a help center, automation rules and an AI assistant on paid plans. Its self-hosting docs ask for at least 4 GB of memory and recommend 4 CPU cores. It runs a Rails app, Sidekiq workers, Postgres and Redis.

There's a longer [Dinghy vs Chatwoot](/compare/chatwoot) page.

## Dinghy

Dinghy is a small open-source live chat I built. A widget on your site, a shared inbox for your team, push alerts on your phone. A reply to a visitor who left goes out by email. There's no built-in bot, no email inbox channel and no Slack replies. But webhooks can tell another app about new messages, and your own AI agent can draft replies through MCP or the API.

To self-host it, you run one install script on a small Linux server. We ran the full install on a 2 vCPU, 4 GB Hetzner CX23 with 5,000 open chat connections, and it peaked at 539 MB of memory. Details are in the [measurements](/docs/measurements). Dinghy Cloud is $9 a month for up to 5 people.

## Moving off Papercups

Dinghy can't import Papercups data. The [self-hosting guide](/docs/self-hosting) has the install, and [moving over from another chat](/compare/#moving-over-from-another-chat) has the steps.

For more options, see [open-source live chat in 2026](/compare/open-source).
