---
title: Self-host a live chat on one small server
nav: Self-host on a small server
description: A step-by-step guide to running Dinghy, an open-source live chat, on one small Linux server with one install script. No third-party account, no license key.
date: 2026-11-09
updated: 2026-11-14
order: 6
card: One install script, a domain and a small server
---

# Self-host a live chat on one small server

Dinghy is free to run yourself, and you don't need an account anywhere to do it. No API key, no license check, and the server never phones home to us. The chat widget, the team inbox, the phone alerts and the nightly backups all come from one install script.

This is the route from an empty server to a chat bubble on your site.

## The server

We tested Dinghy on a Hetzner CX23, which has 2 vCPUs and 4 GB of memory. The whole install idles at about 185 MB and stayed under 600 MB with 5,000 chats open at once. [Our load test post](/blog/one-small-server) has the numbers. We haven't tried anything smaller, so we can't promise it.

When we checked hetzner.com on November 9, 2026, the CX23 was €5.99 a month before VAT, with 40 GB of disk, 20 TB of traffic and an IPv4 address. It was also marked as unavailable that day, so you may need to wait for one or use a similar server from another host.

We've run the installer on Ubuntu 26.04. On a system without `apt`, it falls back to Docker's own install script.

## The domain

Pick an address for the chat, like `chat.example.com`, and point an A record at the server.

If your DNS is on Cloudflare, switch the orange cloud off for that record during the install. The installer fetches an HTTPS certificate, and the proxy gets in the way of the first one. Switch it back on afterwards. [Our post on SSE behind Cloudflare](/blog/sse-behind-cloudflare) explains why chats stay open through it.

The server needs ports 80 and 443 open, including in your host's firewall if it has one. Hetzner's cloud firewall counts.

## The install

The [self-hosting guide](/docs/self-hosting) has the clone command for the latest release. You clone the repository, step into it and run:

```sh
sudo ./install.sh
```

It asks for your domain, email, name, company and website. Then it installs Docker if needed, checks that the domain points at this server and the ports are free, writes the settings file, and starts everything with a real certificate. It also creates your login and, if the server runs cron, a nightly backup.

When it finishes, it prints a backup key, the tag for your website and a one-time sign-in link. Copy all three somewhere safe before you close the terminal. Nothing shows the backup key again, and the sign-in link expires after 15 minutes.

If the installer stops partway, fix whatever it complains about and run it again. It keeps your settings and data. If you lost the sign-in link, make another:

```sh
docker compose exec app chat sign-in-link you@example.com
```

## The chat on your site

Paste the tag before `</body>` on every page, or in your site builder's custom code box. Then open Settings > Install in Dinghy and add your site's address under Allowed sites. The chat only sends messages from addresses on that list, and `www.example.com` and `example.com` count as two.

There are step-by-step [install guides](/guides/) for WordPress, Shopify, Webflow, Next.js and more. [Add the chat to your site](/docs/add-to-your-site) covers colors, your own chat button and showing which signed-in user is chatting.

## Email, if you want it

Dinghy works without a mail server. You just make sign-in links for your team with the command above.

Connect one and a few things get easier. Sign-in links arrive by email, your team can get alerts by email, and visitors who closed the tab and gave an email still get your reply, and a transcript when the conversation closes. Turn on [replies by email](/docs/self-hosting#replies-by-email) too, and they can answer from their mail app, straight into the same conversation. Set `SMTP_URL` and `MAIL_FROM` in `.env`, next to `compose.yaml`, then run:

```sh
docker compose up -d --wait
```

## Backups that would survive a dead disk

The nightly backup keeps the last 7 on the same disk as everything else. That covers a bad upgrade, but not a dead disk. Fill in the `BACKUP_S3_*` settings in `.env` and each backup also goes, encrypted, to a bucket somewhere else.

Keep a copy of `.env` and the backup key off the server too. With a backup file and `.env`, a fresh server can bring everything back.

A backup that silently stopped running is worse than none, because you think you have one. Set `BACKUP_HEARTBEAT_URL` to a free [healthchecks.io](https://healthchecks.io) check, and you'll hear about it the first night one is missing.

## Upgrades

Read the changelog, switch to the new release and restart:

```sh
git fetch --tags
git switch --detach <new release>
docker compose up -d --wait
```

If an upgrade changes how data is stored, it takes a backup first and prints where. The [self-hosting guide](/docs/self-hosting#upgrading) explains how to go back.

Already on Dinghy Cloud? Your workspace exports to one file that imports here. We wrote up [the whole move](/blog/move-to-your-own-server). And if you'd rather not run a server at all, [Dinghy Cloud](https://app.dinghy.chat/signup) is $7 a month for up to 5 people.
