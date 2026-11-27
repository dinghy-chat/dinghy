---
title: 5,000 live chats on a 4 GB server: our load test | Dinghy
nav: One small server, 5,000 chats
description: We load-tested the full Dinghy install on one Hetzner CX23 with 2 vCPUs and 4 GB. It held 5,000 open chats with uploads in 539 MB. Here's what broke first.
date: 2026-11-08
updated: 2026-11-27
order: 1
card: 5,000 open chats on one small server, in 539 MB
image: one-small-server
---

# What one small server handled in our load test

We ran Dinghy on a 4 GB server and used another server to open chats, send messages and upload photos. Here’s what the test measured.

## How we set it up

The server under test was a Hetzner CX23 in Falkenstein, 2 shared vCPUs and 4 GB of memory. It ran the real install, the same `compose.yaml` the install script gives you, with one process doing both web requests and background jobs.

![A second server in the same data center played the visitors and sent chats, messages and 3.9 MB photos to the server under test, which has 2 vCPUs and 4 GB and sent a push for each message to a stand-in push service.](/img/illustrations/one-small-server-test-setup.png)

A second CX23 in the same data center played the visitors. It opened chats, sent messages and uploaded photos.

Every visitor message set off a push notification, which the server had to encrypt and send to a stand-in push service. Every upload was a 3.9 MB, 12-megapixel JPEG, which the server decodes and shrinks like it does real photos.

## What it held

5,000 chats open at once, 20 messages a second, and one big photo every second. Memory peaked at 539 MB. Zero messages lost. Half arrived within 30 ms, 99% within 628 ms.

The install used about 185 MB at idle.

## What broke first

Not memory. Even at the peak, most of the 4 GB was free.

![Memory peaked at 539 MB of 4 GB, so it was not the limit; the limit was messages in one workspace taking turns on one database row, and photo uploads past the ceiling were refused.](/img/illustrations/one-small-server-bottleneck.png)

The limit was messages per second in one workspace. At 50 a second everything stayed quick. When we asked for 100, the server managed about 90, and messages started arriving 9 to 15 seconds late. Messages in one workspace take turns on one database row, and that puts a ceiling on each workspace.

Photos had a ceiling too, at about 2.6 of those big files a second. Past that, the server turned extra uploads away with an error, and chat messages kept flowing meanwhile.

## The bigger number

The day before, we tested open connections alone, no background jobs and no photos. The same size of server held 20,000 open chats in about 1 GB of memory. Opening all of them took 70 seconds, with the CPU close to its limit.

## What this test doesn't tell you

No HTTPS on the server under test, and in real life encryption costs some CPU. The push service was a stand-in, not Apple's or Google's. Email was off, and photos stayed on the server's disk instead of S3. And it was all one workspace. Separate workspaces don't share that database row, so they should handle more messages in total. We haven't measured it.

## Run the benchmark yourself

On a Linux machine with Docker and Compose, clone the release below. The runner starts an isolated Dinghy stack, generates chats and uploads, and removes the stack when it finishes.

```sh
git clone --branch v0.60.1 --depth 1 https://github.com/dinghy-chat/dinghy.git
cd dinghy
scripts/capacity-check.sh ghcr.io/dinghy-chat/dinghy:0.60.1 1000 20 60 1
```

The last four arguments specify open connections, messages per second, test seconds and uploads per second. The command prints a JSON record with peak memory, delivery times, failures and the alert backlog. We ran this version locally on Nov 27, 2026. It opened 1,000 connections, delivered all 1,195 messages and accepted all 59 uploads.

For the original 5,000-connection workload, use `5000 20 60 1`. Run the load generator on a second machine to keep its resource use out of the server measurement. The [measurements page](/docs/measurements#2026-11-06-the-full-install-on-a-real-cx23) has the remote command, the original results and the test limits. Getting different results? [Email us](mailto:hello@dinghy.chat), I'd like to know.
