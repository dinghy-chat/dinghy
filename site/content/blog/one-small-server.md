---
title: 5,000 live chats on a 4 GB server: our load test | Dinghy
nav: One small server, 5,000 chats
description: We load-tested the full Dinghy install on one Hetzner CX23 with 2 vCPUs and 4 GB. It held 5,000 open chats with uploads in 539 MB. Here's what broke first.
date: 2026-11-08
order: 1
card: 5,000 open chats on one small server, in 539 MB
---

# What one small server handled in our load test

Dinghy is built to run on one small server. Before saying that in public, we wanted proof, so we rented two small servers and tried to break one with the other.

## How we set it up

The server under test was a Hetzner CX23 in Falkenstein, with 2 shared vCPUs and 4 GB of memory. It ran the real install, the same `compose.yaml` the install script gives you, with a single process handling both web requests and background jobs.

A second CX23 in the same data center played the visitors. It opened chats, sent messages and uploaded photos.

We made it harder than real life on purpose. Every visitor message set off a push notification, which the server had to encrypt and send to a stand-in push service. Every upload was a 3.9 MB, 12-megapixel JPEG, which the server decodes and shrinks the same way it does real photos.

## What it held

5,000 chats open at once, 20 messages a second, and one big photo every second. Memory peaked at 539 MB. Not a single message was lost. Half of them arrived within 30 ms, and 99% within 628 ms.

20 messages a second works out to 1.7 million a day, far more than a small team could ever answer. Sitting idle, the whole install uses about 185 MB.

## What broke first

It wasn't memory. Even at the top of the test, most of the 4 GB was free.

The limit was how many messages one workspace can take per second. At 50 a second, everything stayed quick. When we asked for 100, the server managed about 90, and messages started arriving 9 to 15 seconds late. That's a choice we made in the design. Messages in one workspace take turns on one database row, and that puts a ceiling on each workspace.

Photos had a ceiling too, at about 2.6 of those big files a second. Past that, the server turned extra uploads away with an error, and chat messages kept flowing while it did. That's the behavior we wanted.

## The bigger number

The day before, we tested open connections on their own, with no background jobs and no photos. The same size of server held 20,000 open chats in about 1 GB of memory. Opening all of them took 70 seconds, with the CPU close to its limit.

## What this test doesn't tell you

There was no HTTPS on the server under test, and in real life encryption costs some CPU. The push service was a stand-in, not Apple's or Google's. Email was off, and photos stayed on the server's disk instead of going to S3. And everything happened in one workspace. Separate workspaces don't share that one database row, so they should handle more messages in total, but we haven't measured it.

We care about these numbers because when you self-host, the server is your monthly bill. A chat that needs 8 GB and four cores costs you every month, forever. One that idles at 185 MB fits on a small server, next to whatever else you run there.

The [measurements page](/docs/measurements) has every number, plus the commands to run the test yourself. If you get different results, [email us](mailto:hello@dinghy.chat). We'd like to know.
