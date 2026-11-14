---
title: How Dinghy keeps live chat open behind Cloudflare
nav: SSE behind Cloudflare
description: Dinghy sends with POST and receives with server-sent events. How a 25-second heartbeat keeps chats open behind Cloudflare, and how clients catch up.
date: 2026-11-09
order: 3
card: A ping every 25 seconds, and cursors so nothing gets lost
---

# How Dinghy keeps live chat open behind Cloudflare

A visitor opens your chat, asks a question, then goes to read your pricing page. Ten minutes later you answer. Your reply has to pop up on their screen right away, even though their browser and your server haven't said a word to each other in ten minutes.

That quiet connection is the hard part of live chat. Anything sitting between the browser and your server can decide an idle connection is dead and close it. For most people that thing is Cloudflare, so this is how Dinghy gets along with it.

## Why there are no WebSockets

The browser sends a message with a plain `POST`. It receives messages over server-sent events, or SSE, which is one long HTTP response that the server keeps adding to.

We picked that because every proxy already understands it. To Caddy, nginx or Cloudflare, an SSE stream is just a slow response. The only thing that can break it is a proxy that holds the response back until it's finished, so every stream carries `X-Accel-Buffering: no`, the header nginx listens to.

Sending as a normal request has a nice side effect. Each message gets an ID made by the browser, 32 random hex characters. If the network drops halfway through a send, the browser sends it again with the same ID, and the server hands back the first copy instead of saving a second one. Rate limits work like they do for any request, with a status code and a `Retry-After` header.

The widget doesn't use the browser's built-in `EventSource`, because that can't send an `Authorization` header and the widget needs one. It reads the stream with `fetch` instead.

Waiting streams are cheap. A stream holds no database connection while nothing happens. When something new arrives in a workspace, a signal goes out through Valkey, and the streams for that workspace read the new events from Postgres. In [our load test](/blog/one-small-server), one 4 GB server kept 20,000 streams open in about 1 GB of memory.

## The timeout, and the ping

Cloudflare closes a proxied request when your server sends nothing for too long, and the visitor gets a 524 error. Cloudflare calls it the Proxy Read Timeout. Its [connection limits page](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) said 125 seconds when we checked on November 9, 2026, and only Enterprise plans can change it.

So every 25 seconds, each Dinghy stream writes one line:

```text
: ping
```

In SSE, a line that starts with a colon is a comment. The browser throws it away and our code never sees it. But to Cloudflare it's fresh data from the server, and the clock starts over.

We checked this on November 5, 2026, through a proxied hostname on Cloudflare's Free plan. One stream sat idle for 180 seconds and stayed open, with 7 pings along the way. Then a message went through on that same connection, 237 ms after it was sent. The [measurements page](/docs/measurements) has the details.

The same ping covers your own nginx or Traefik if you self-host, as long as its idle timeout is 60 seconds or more. The [self-hosting guide](/docs/self-hosting#behind-your-own-reverse-proxy) has an nginx block with `proxy_read_timeout 120s`. With Cloudflare and your own proxy both in front, set `TRUSTED_PROXY_HOPS` to 2, so rate limits see the visitor's real address.

## Streams end on purpose

We don't let any stream live forever, even a healthy one. Each one closes within 15 minutes, at a random point between 12 and 15, so a crowd of streams that opened together doesn't reconnect in the same second.

The server says why it's closing with a `close` event, such as `lifetime`, `expired` or `stopping`, and the browser opens a new stream. That regular restart is also when the server checks again that the client is still allowed in.

## Picking up where it left off

Every event in a workspace has a cursor, like `generation.seq`, and the number only goes up. A message and its event are saved in the same Postgres transaction, so an event can never show up behind a cursor the client already has.

When a stream drops, the browser reconnects with the last cursor it saw. The server replays everything after it, sends `ready`, and the stream is live again.

A cursor stops being useful after a restore or an import, which gives the workspace a new generation, or once its old events have been cleaned up. Then the server answers `resync`, and the browser reloads the whole conversation.

If reconnecting fails, the browser waits 1 second, then 2, then 4, up to 30, with a little randomness so a thousand visitors don't all come back at the same moment after an outage. If the server asked it to wait with a `Retry-After`, it waits exactly that long. The visitor sees "Connection lost. Trying again..." in the meantime.

## Only the tab you're looking at

Browsers allow about six HTTP/1.1 connections per site, shared by every tab. Someone with eight tabs of your docs open would run out. So only the visible tab keeps a Dinghy stream. The others let go and catch up from their cursor when you switch back.

[The architecture page](/docs/architecture) goes deeper on cursors and signals, and [the API page](/docs/api#live-updates) lists every stream event.
