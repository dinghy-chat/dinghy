---
title: Papercups alternative: what to use now that it's inactive | Dinghy
nav: Papercups alternatives
description: Papercups, the open-source Intercom alternative, has had no code change since May 2022. Here are two maintained options, Chatwoot and Dinghy.
date: 2026-11-09
updated: 2026-11-14
order: 11
card: No code change since 2022. Two maintained options
stat: Unmaintained
---

# Papercups is no longer maintained. Here's what to use now

Papercups was a nice open-source live chat written in Elixir, with a hosted version and a self-hosted one. It went into maintenance mode in January 2022, and the last code change on GitHub is from May 10, 2022. If you still run it, it's time to move.

## Where Papercups stands today

We checked on November 9, 2026.

- The [GitHub repo](https://github.com/papercups-io/papercups) isn't archived, but its README says it's in maintenance mode, and nobody has committed code since May 2022.
- papercups.io returns a 404, and app.papercups.io, the hosted version, no longer resolves.
- An open issue from June 2024 reports the Heroku deploy broken on Node 18, and it's still open.

The code is MIT, so you can keep running your copy. Just know that nobody ships security fixes or updates for it.

## The quick answer

If you used Papercups for its Slack and Mattermost replies, email or SMS, look at Chatwoot. It's a popular open-source support inbox, it's actively developed, and it has a free cloud plan. If you used Papercups for chat on your website and nothing else, Dinghy is closer to what you had, and lighter to run.

## What it costs now

| | Dinghy | Chatwoot | Papercups |
|---|---|---|---|
| Self-hosted | Free, AGPL 3.0, widget MIT | Free, MIT, with an `enterprise/` folder under its own license | Free, MIT, unmaintained |
| Hosted, 1 person | $7 a month | $0 on Hacker, or $19 on Startups | Gone |
| Hosted, 3 people | $7 a month | $57 a month on Startups | Gone |
| Hosted, 5 people | $7 a month | $95 a month on Startups | Gone |
| Last code change | November 2026 | November 2026 | May 2022 |

Chatwoot prices are from chatwoot.com/pricing on November 9, 2026. Its free Hacker plan has 2 agents, 500 conversations a month, live chat only, and 30 days of history. [All the prices side by side](/compare/).

## Chatwoot

Chatwoot is the big open-source option. It does live chat, email, WhatsApp, Facebook and more in one inbox, with a help center, automation rules and an AI assistant on paid plans. Its self-hosting docs ask for at least 4 GB of memory and recommend 4 CPU cores, and it runs a Rails app, Sidekiq workers, Postgres and Redis.

It fits teams that want many channels in one place. We wrote a longer [Dinghy vs Chatwoot](/compare/chatwoot) page.

## Dinghy

Dinghy is a small open-source live chat. A widget on your site, a shared inbox for your team and push alerts on your phone. A reply to a visitor who left goes by email. It has no built-in bot, no email inbox channel and no Slack replies, but webhooks can tell another app about new messages, and your own AI agent can draft replies through MCP or the API.

Self-hosting it means one install script on a small Linux server. We ran the full install on a 2 vCPU, 4 GB Hetzner CX23 with 5,000 open chat connections, and it peaked at 539 MB of memory. The [measurements](/docs/measurements) have the details. If you'd rather not run anything, Dinghy Cloud is $7 a month for up to 5 people.

It fits people who used Papercups for one thing, the chat on their site.

## Moving off Papercups

Dinghy has no importer for Papercups data. The [self-hosting guide](/docs/self-hosting) has the install, and [moving over from another chat](/compare/#moving-over-from-another-chat) has the steps.

For a wider look at the options, see [open-source live chat in 2026](/compare/open-source).
