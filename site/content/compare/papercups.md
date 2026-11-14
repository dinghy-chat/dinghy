---
title: Papercups alternative: what to use now that it's inactive | Dinghy
nav: Papercups alternatives
description: Papercups, the open-source Intercom alternative, has had no code change since May 2022. Two maintained options: Chatwoot and Dinghy.
date: 2026-11-09
updated: 2026-11-14
order: 11
card: No code change since 2022. Two maintained options
stat: Unmaintained
---

# Papercups is no longer maintained. What to use now

Papercups was an open-source live chat written in Elixir. You could use the hosted version or run it yourself. It went into maintenance mode in January 2022, and the last code change on GitHub is from May 10, 2022.

## Where Papercups stands today

I checked on November 9, 2026.

- The [GitHub repo](https://github.com/papercups-io/papercups) isn't archived. But the README says it's in maintenance mode, and nobody has committed code since May 2022.
- papercups.io returns a 404, and app.papercups.io, the hosted version, doesn't resolve anymore.
- An issue from June 2024 says the Heroku deploy is broken on Node 18. It's still open.

The code is MIT, so you can keep running your copy. Just know nobody ships security fixes or updates for it.

## The quick answer

If you used Papercups for its Slack and Mattermost replies, email or SMS, look at Chatwoot. Chatwoot is still maintained and has a free cloud plan. If you used Papercups only for website chat, Dinghy does that and needs less to run.

## What it costs now

| | Dinghy | Chatwoot | Papercups |
|---|---|---|---|
| Self-hosted | Free, AGPL 3.0, widget MIT | Free, MIT, with an `enterprise/` folder under its own license | Free, MIT, unmaintained |
| Hosted, 1 person | $7 a month | $0 on Hacker, or $19 on Startups | Gone |
| Hosted, 3 people | $7 a month | $57 a month on Startups | Gone |
| Hosted, 5 people | $7 a month | $95 a month on Startups | Gone |
| Last code change | November 2026 | November 2026 | May 2022 |

Chatwoot prices are from chatwoot.com/pricing on November 9, 2026. The free Hacker plan has 2 agents, 500 conversations a month, live chat only, and 30 days of history. [All the prices side by side](/compare/).

## Chatwoot

Chatwoot is open source. Live chat, email, WhatsApp, Facebook and more in one inbox, plus a help center, automation rules and an AI assistant on paid plans. Its self-hosting docs ask for at least 4 GB of memory and recommend 4 CPU cores. It runs a Rails app, Sidekiq workers, Postgres and Redis.

There's a longer [Dinghy vs Chatwoot](/compare/chatwoot) page.

## Dinghy

Dinghy is a small open-source live chat I built. A widget on your site, a shared inbox for your team, push alerts on your phone. A reply to a visitor who left goes out by email. There's no built-in bot, no email inbox channel and no Slack replies. But webhooks can tell another app about new messages, and your own AI agent can draft replies through MCP or the API.

To self-host it, you run one install script on a small Linux server. We ran the full install on a 2 vCPU, 4 GB Hetzner CX23 with 5,000 open chat connections, and it peaked at 539 MB of memory. Details are in the [measurements](/docs/measurements). Dinghy Cloud is $7 a month for up to 5 people.

## Moving off Papercups

Dinghy can't import Papercups data. The [self-hosting guide](/docs/self-hosting) has the install, and [moving over from another chat](/compare/#moving-over-from-another-chat) has the steps.

For more options, see [open-source live chat in 2026](/compare/open-source).
