---
title: Self-host a live chat on one small server
nav: Self-host on a small server
description: How to run Dinghy, an open-source live chat, on one small Linux server with one install script. No third-party account, no license key.
date: 2026-11-09
updated: 2026-11-14
order: 6
card: One install script, a domain and a small server
---

# Self-host a live chat on one small server

You can run Dinghy yourself for free, and you don't need an account anywhere. No API key, no license check, and the server never phones home to us. One install script sets up the chat widget, the team inbox, the phone alerts and the nightly backups.

## The server

I tested Dinghy on a Hetzner CX23. It has 2 vCPUs and 4 GB of memory. The whole install idles at about 185 MB, and it stayed under 600 MB with 5,000 chats open at once. [Our load test post](/blog/one-small-server) has the numbers. We haven't tested a smaller server.

On November 9, 2026, hetzner.com listed the CX23 at €5.99 a month before VAT, with 40 GB of disk, 20 TB of traffic and an IPv4 address. But it was marked as unavailable that day. So you may have to wait for one, or take a similar server from another host.

We've run the installer on Ubuntu 26.04. If the system has no `apt`, it falls back to Docker's own install script.

## The domain

Pick an address for the chat, like `chat.example.com`, and point an A record at the server.

DNS on Cloudflare? Switch the orange cloud off for that record while you install. The installer fetches an HTTPS certificate, and the proxy gets in the way of the first one. Switch it back on after. [Our post on SSE behind Cloudflare](/blog/sse-behind-cloudflare) explains why chats stay open through it.

Ports 80 and 443 have to be open, in your host's firewall too if it has one. Hetzner's cloud firewall counts.

## The install

The [self-hosting guide](/docs/self-hosting) has the clone command for the latest release. Clone the repo, step into it and run:

```sh
sudo ./install.sh
```

It asks for your domain, email, name, company and website. Then it installs Docker if needed, checks that the domain points at this server and the ports are free, writes the settings file, and starts everything with a real certificate. It also creates your login, and a nightly backup if the server runs cron.

At the end it prints a backup key, the tag for your website and a one-time sign-in link. Copy all three somewhere safe before you close the terminal. You won't see the backup key again, and the sign-in link expires after 15 minutes.

If the installer stops partway, fix what it complains about and run it again. It keeps your settings and data. Lost the sign-in link? Make another:

```sh
docker compose exec app chat sign-in-link you@example.com
```

## The chat on your site

Paste the tag before `</body>` on every page, or in your site builder's custom code box. Then open Settings > Install in Dinghy and add your site's address under Allowed sites. The chat only sends messages from addresses on that list. And `www.example.com` and `example.com` count as two.

There are step-by-step [install guides](/guides/) for WordPress, Shopify, Webflow, Next.js and more. [Add the chat to your site](/docs/add-to-your-site) covers colors, your own chat button and showing which signed-in user is chatting.

## Email, if you want it

Dinghy works without a mail server. Use the command above to make sign-in links for your team.

With one connected, sign-in links arrive by email and your team can get alerts by email. Visitors who closed the tab and left an email still get your reply, plus a transcript when the conversation closes. Turn on [replies by email](/docs/self-hosting#replies-by-email) too, and they can answer from their mail app, straight into the same conversation. Set `SMTP_URL` and `MAIL_FROM` in `.env`, next to `compose.yaml`, then run:

```sh
docker compose up -d --wait
```

## Backups that would survive a dead disk

The nightly backup keeps the last 7, on the same disk as everything else. That covers a bad upgrade. It doesn't cover a dead disk. Fill in the `BACKUP_S3_*` settings in `.env` and each backup also goes, encrypted, to a bucket somewhere else.

Keep a copy of `.env` and the backup key off the server too. A backup file plus `.env` brings everything back on a fresh server, except images and files in S3, which the bucket keeps.

Set `BACKUP_HEARTBEAT_URL` to a free [healthchecks.io](https://healthchecks.io) check, and you'll hear about it the first night one is missing.

## Upgrades

Read the changelog, switch to the new release and restart:

```sh
git fetch --tags
git switch --detach <new release>
docker compose up -d --wait
```

If an upgrade changes how data is stored, it takes a backup first and prints where it put it. The [self-hosting guide](/docs/self-hosting#upgrading) explains how to go back.

Already on Dinghy Cloud? Your workspace exports to one file that imports here. I wrote up [the whole move](/blog/move-to-your-own-server). And if you'd rather not run a server at all, [Dinghy Cloud](https://app.dinghy.chat/signup) is $7 a month for up to 5 people.
