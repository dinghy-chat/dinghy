---
title: Live chat for developer tools and docs sites | Dinghy
nav: Docs and dev tools
description: Open-source live chat for dev tools, open-source projects and docs sites. Self-host it, a script under 4 KB, and it runs under a strict CSP.
date: 2026-11-09
updated: 2026-11-14
order: 5
card: Open source, light, and fine with a strict CSP
---

# Live chat for developer tools and docs sites

Dinghy is an open-source live chat. The tag loads a script under 4 KB. It runs under a strict Content Security Policy with no `unsafe-inline`. And you can host all of it yourself. The server is AGPL, the widget is MIT, and the code is on [GitHub](https://github.com/dinghy-chat/dinghy).

## Why it fits a docs site

**The script is small.** The tag loads a script under 4 KB with `async`. The full chat loads when a reader opens it or comes back to a chat. A reader who never uses it never downloads it.

**It doesn't fight your theme.** The widget renders in its own Shadow DOM. Your docs theme's CSS can't break it, and its CSS can't leak into your pages. Pick your colors, the chat button and a light, dark or automatic theme in Settings > Appearance, or set `data-primary` and `data-accent` on the tag. `data-mascot="false"` hides the little boat.

**It works under a strict CSP.** Allow your Dinghy address in three directives:

```text
script-src https://chat.example.com;
connect-src https://chat.example.com;
img-src https://chat.example.com;
```

No `unsafe-inline` needed. If you serve images and files from a separate origin, see [the CSP section](/docs/add-to-your-site#if-your-site-has-a-content-security-policy).

**It's open source.** The widget is MIT, so you can use it on any site, commercial or not.

## Add it to your docs

Paste the tag before `</body>` on every page. Most docs generators have a spot for that, like a custom footer or a theme override. Then add the docs site's address under Allowed sites in Settings > Install. `https://docs.example.com` and `https://example.com` are two different sites, so list every one the chat runs on.

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

If your product has accounts, your server can sign a token so the chat knows which user is asking. Steps are in [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).

## Host it yourself

Self-hosting is free. You don't need a third-party account or an API key. Dinghy has no license check and sends no telemetry. It's one Docker image with Postgres and Valkey. One install script on a fresh Linux server sets up Docker, HTTPS and your login. Commands, backups and upgrades are in the [self-hosting guide](/docs/self-hosting).

Every install has an HTTP API with an OpenAPI description at `/v1/openapi.json`, webhooks for 10 events, and an MCP server at `/v1/mcp`. The widget is on npm too, as `@dinghy-chat/widget`. See [the API page](/docs/api) and [Use Dinghy with AI agents](/docs/agents).

Or skip the server and use Dinghy Cloud, $7 a month for up to 5 people. A workspace exports to one file that imports into a self-hosted Dinghy, so you can move later.

## When Dinghy isn't the right fit

- Your questions are better answered in public. If the same question comes up a hundred times, GitHub Discussions or a forum leaves an answer the next person can find. A chat leaves it in one inbox.
- Nobody on the project can watch the inbox. If nobody checks the inbox, use an issue tracker.
- You want a hosted AI agent that reads your docs and answers with no setup. Dinghy has no AI of its own. You can connect your own bot through MCP or the API, and by default its replies wait as drafts for a person. See [Live chat for AI agents](/for/ai-agents).
- You want a community chat where users talk to each other. Dinghy is one visitor talking to your team.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. More on the stack and the license in [Open-source live chat](/open-source-live-chat).
