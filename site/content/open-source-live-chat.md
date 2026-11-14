---
title: Open-source live chat you can host yourself | Dinghy
nav: Open-source live chat
description: Dinghy is an open-source live chat for your website. Run it free on one small server with one script, or let us host it for $7 a month.
date: 2026-11-08
updated: 2026-11-14
order: 1
card: Free on your server, or $7 on ours
---

# Open-source live chat you can host yourself

Dinghy is a live chat for your website, and all of it is open source. You can run it on your own server for free, or pay us $7 a month to run it for you on Dinghy Cloud. Same code either way.

## The short version

- A chat button on your site, and a shared inbox where your team answers.
- The server is AGPL 3.0. The widget you embed is MIT, so it is fine on any site, commercial or not.
- One Docker image, plus Postgres and Valkey. That's the whole stack.
- One install script on a fresh Linux server. It sets up Docker, HTTPS and your login.
- No license check, no telemetry, and you don't need a third-party account or an API key.
- An HTTP API, webhooks and an MCP server, so your own scripts and AI agents can work with it.
- We measured it on a 2 vCPU, 4 GB server. The numbers are below.

The code is on [GitHub](https://github.com/dinghy-chat/dinghy).

## Why we made another one

Most open-source chat tools grew into full help desks. They have email, WhatsApp, help centers, bots and automation rules. That's great if you need all of it. It's a lot to run if you just want people on your site to reach you.

Dinghy stays small on purpose. It's the chat, a shared inbox with saved replies, notes, labels and analytics, alerts so you don't miss anything, and an API for the rest. Fewer parts means fewer things to update and back up.

## Installing it

On a new Linux server, you clone the repo at the latest release and run `sudo ./install.sh`. The script asks for your domain and email, installs Docker if it's missing, gets a real HTTPS certificate, sets up nightly backups if the server runs cron, and prints a sign-in link plus the tag for your site.

The [self-hosting guide](/docs/self-hosting) has the exact commands, the settings, backups, restores and upgrades.

Email and S3 storage are optional. Without a mail server, Dinghy still works. It just can't send email to you or your visitors.

## What one small server can handle

We ran the full install on a Hetzner CX23, which has 2 shared vCPUs and 4 GB of memory. With 5,000 open chat connections, 20 messages a second and a large image upload every second, it peaked at 539 MB of memory, and no message failed. In an earlier run, the same size of server held 20,000 open connections in about 1 GB, without the background jobs or images.

There are limits. Above about 50 messages a second inside one workspace, delivery starts to lag. We didn't test TLS on the server or many workspaces at once. The [measurements page](/docs/measurements) has every number and every caveat, and [the blog post](/blog/one-small-server) explains them in plain words.

## Self-hosted or Dinghy Cloud

| | Self-hosted | Dinghy Cloud |
|---|---|---|
| Price | Free | $7 a month per workspace |
| Who runs it | You | Us |
| Updates and backups | You run them | We run them |
| Operators | As many as you like | Up to 5 |
| Images and files | As much as your disk holds | 1 GB, kept 12 months |
| Your data | On your server | Exports to a file that imports into a self-hosted install |

So you can start on the cloud, and if you ever want to leave, export a file and import it into your own server.

## What it doesn't do

Dinghy has no AI of its own, no marketing campaigns, no help center, and no other channels like a shared email inbox or WhatsApp. If you need those, [Chatwoot](/compare/chatwoot) is the open-source tool to look at, and it's a good one.

You can still bring your own AI agent. It connects through the MCP server or the API, and its replies wait as drafts for a person to send unless you let it send directly. Self-host Dinghy, run the bot with a model on your own server, and no chat leaves your machines. See [Live chat for AI agents](/for/ai-agents).

## How it compares

- [Dinghy vs Chatwoot](/compare/chatwoot), the other open-source option
- [Dinghy vs Intercom](/compare/intercom)
- [Dinghy vs Crisp](/compare/crisp)
- [Live chat prices for 1, 3 and 5 people](/compare/)
