---
title: How Dinghy keeps live chat open behind Cloudflare
nav: SSE behind Cloudflare
description: Dinghy sends with POST and receives with server-sent events. How a 25-second ping keeps chats open behind Cloudflare, and how clients catch up.
date: 2026-11-09
updated: 2026-11-14
order: 3
card: A ping every 25 seconds, and cursors so nothing gets lost
---

# How Dinghy keeps live chat open behind Cloudflare

A visitor opens your chat, asks a question, then goes off to read your pricing page. Ten minutes later you answer. Your reply has to show up on their screen right away, even though nothing real has gone between their browser and your server in ten minutes.

Anything between the browser and your server can decide an idle connection is dead and close it.

## Why there are no WebSockets

The browser sends a message with a plain `POST`. It gets messages over server-sent events, or SSE. That's one long HTTP response the server keeps adding to.

I picked that because every proxy already understands it. To Caddy, nginx or Cloudflare, an SSE stream is just a slow response. The only thing that breaks it is a proxy that holds the response back until it's done. So every stream sends `X-Accel-Buffering: no`, the header nginx looks at.

Each message gets an ID made by the browser, 32 random hex characters. If the network drops halfway through a send, the browser sends it again with the same ID, and the server hands back the first copy instead of saving a second one. Rate limits work like for any request, with a status code and a `Retry-After` header.

The widget doesn't use the browser's built-in `EventSource`. It can't send an `Authorization` header, and the widget needs one. So it reads the stream with `fetch`.

A stream holds no database connection while nothing happens. When something new comes in for a workspace, a signal goes out through Valkey, and that workspace's streams read the new events from Postgres. In [our load test](/blog/one-small-server), one 4 GB server kept 20,000 streams open in about 1 GB of memory.

## The timeout, and the ping

Cloudflare closes a proxied request when your server sends nothing for too long, and the visitor gets a 524 error. Cloudflare calls it the Proxy Read Timeout. Its [connection limits page](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) said 125 seconds when we checked on November 9, 2026. Only Enterprise plans can change it.

So every 25 seconds, each Dinghy stream writes one line:

```text
: ping
```

In SSE, a line that starts with a colon is a comment. Our client skips it. But for Cloudflare it's fresh data from the server, and the clock starts over.

We tested this on November 5, 2026, through a proxied hostname on Cloudflare's Free plan. One stream sat idle for 180 seconds and stayed open, with 7 pings along the way. Then a message went through on that same connection, 237 ms after it was sent. The [measurements page](/docs/measurements) has the details.

If you self-host behind your own nginx or Traefik, the same ping covers it, as long as its idle timeout is 60 seconds or more. The [self-hosting guide](/docs/self-hosting#behind-your-own-reverse-proxy) has an nginx block with `proxy_read_timeout 120s`. With Cloudflare and your own proxy both in front, set `TRUSTED_PROXY_HOPS` to 2, so rate limits see the visitor's real address.

## Streams end on purpose

Each one closes within 15 minutes, at a random point between 12 and 15. That way a crowd of streams that opened together doesn't reconnect in the same second.

The server says why it's closing with a `close` event, like `lifetime`, `expired` or `stopping`, and the browser opens a new stream. That restart is also when the server checks again that the client is still allowed in.

## Picking up where it left off

Every event in a workspace has a cursor, like `generation.seq`, and the number only goes up. A message and its event are saved in the same Postgres transaction, so an event can never show up behind a cursor the client already has.

When a stream drops, the browser reconnects with the last cursor it saw. The server replays everything after it, sends `ready`, and the stream is live again.

A cursor stops working after a restore or an import, because those give the workspace a new generation. Same once its old events have been cleaned up. Then the server answers `resync`, and the browser reloads the whole conversation.

If reconnecting fails, the browser waits 1 second, then 2, then 4, up to 30. There's a bit of randomness in there, so a thousand visitors don't all come back at the same moment after an outage. If the server sent a `Retry-After`, it waits exactly that long. Meanwhile the visitor sees "Connection lost. Trying again...".

## Only the tab you're looking at

Browsers allow about six HTTP/1.1 connections per site, shared by every tab. Someone with eight tabs of your docs open would run out. So only the visible tab keeps a Dinghy stream. The others let go and catch up from their cursor when you switch back.

[The architecture page](/docs/architecture) goes deeper on cursors and signals, and [the API page](/docs/api#live-updates) lists every stream event.
