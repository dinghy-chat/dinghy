---
title: Live chat for developer tools and docs sites | Dinghy
nav: Docs and dev tools
description: Open-source live chat for developer tools, open-source projects and docs sites. Self-host it, keep the script under 4 KB, and run it under a strict CSP.
date: 2026-11-09
updated: 2026-11-14
order: 5
card: Open source, light, and fine with a strict CSP
---

# Live chat for developer tools and docs sites

Dinghy is open-source live chat that fits a docs site. The tag loads a script under 4 KB, it runs under a strict Content Security Policy with no `unsafe-inline`, and you can host the whole thing yourself. The server is AGPL and the widget is MIT, and the code is on [GitHub](https://github.com/dinghy-chat/dinghy).

## Why it fits a docs site

**The script is small.** The tag loads a script under 4 KB with `async`. The full chat loads only when a reader opens it, so a new reader who never opens it never downloads it.

**It doesn't fight your theme.** The widget renders in its own Shadow DOM. Your docs theme's CSS can't break it, and its CSS can't leak into your pages. Pick your colors, the chat button and a light, dark or automatic theme in Settings > Appearance, or set `data-primary` and `data-accent` on the tag. `data-mascot="false"` drops the little boat.

**It works under a strict CSP.** Allow your Dinghy address in three directives:

```text
script-src https://chat.example.com;
connect-src https://chat.example.com;
img-src https://chat.example.com;
```

Dinghy needs no `unsafe-inline`. [The CSP section](/docs/add-to-your-site#if-your-site-has-a-content-security-policy) covers the case where you serve images and files from a separate origin.

**It's open source.** You can read the code you put on your site. The widget is MIT, so it's fine on any site, commercial or not.

## Add it to your docs

Paste the tag before `</body>` on every page. Most docs generators have a place for that, like a custom footer or a theme override. Then add the docs site's address under Allowed sites in Settings > Install. `https://docs.example.com` and `https://example.com` are two different sites, so list each one the chat runs on.

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

If your product has accounts, your server can sign a token so the chat knows which user is asking. [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) has the steps.

## Host it yourself

Self-hosting is free and needs no third-party account and no API key. Dinghy has no license check and sends no telemetry. It's one Docker image with Postgres and Valkey, and one install script on a fresh Linux server sets up Docker, HTTPS and your login. The [self-hosting guide](/docs/self-hosting) has the commands, backups and upgrades.

Developer tool? Dinghy has an HTTP API with an OpenAPI description at `/v1/openapi.json` on every install, webhooks for 10 events, and an MCP server at `/v1/mcp`. The widget is also on npm as `@dinghy-chat/widget`. See [the API page](/docs/api) and [Use Dinghy with AI agents](/docs/agents).

Or skip the server and use Dinghy Cloud for $7 a month, for up to 5 people. A workspace exports to one file that imports into a self-hosted Dinghy, so you can move later.

## When Dinghy isn't the right fit

- Your questions are better answered in public. If the same question comes up a hundred times, GitHub Discussions or a forum leaves an answer the next person can find. A chat leaves it in one inbox.
- Nobody on the project can watch the inbox. A chat button with no one behind it is worse than an issue tracker.
- You want a hosted AI agent that reads your docs and answers with no setup. Dinghy has no AI of its own. You can connect your own bot through MCP or the API, and its replies wait as drafts for a person by default. See [Live chat for AI agents](/for/ai-agents).
- You want a community chat, where users talk to each other. Dinghy is one visitor talking to your team.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. [Open-source live chat](/open-source-live-chat) has more on the stack and the license.
