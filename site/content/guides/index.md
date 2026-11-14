---
title: Install guides: add live chat to your website | Dinghy
nav: All guides
description: Step-by-step guides to add the Dinghy live chat to WordPress, Shopify, Webflow, Wix, Squarespace, Framer, Next.js, React and more. Most are a single paste.
date: 2026-11-08
updated: 2026-11-14
order: 0
---

# Add live chat to your website

Dinghy is one script tag. Every guide here comes down to the same three steps: get your tag, paste it into each page, and tell Dinghy which site it's on. The guides show where that paste goes on each platform.

## Pick your platform

<!-- pages 1-19 -->

Using something else? If you can add a script to every page, Dinghy works. [Any website](/guides/html) shows the plain version, and [Add the chat to your site](/docs/add-to-your-site) has every option, like colors, your own chat button and signed-in users.

Working with a coding agent? [Claude Code](/guides/claude-code), Cursor or another MCP client can install the chat for you.

## Before you start

You need a Dinghy install and its tag. On a [self-hosted install](/docs/self-hosting), the installer prints the tag at the end, and it's also in the operator app under Settings > Install. On Dinghy Cloud, it's in the same place.

The tag looks like this:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

The `data-key` is public. It only names your workspace, so it's safe in your page source and in git.

## Add your site to Allowed sites

Add your site's address under Allowed sites in Settings > Install, like `https://www.example.com`. The chat only works on sites on the list. Elsewhere the button still shows, but messages don't send. `https://example.com` and `https://www.example.com` count as two different sites, so add both if visitors use both.

## Signed-in users

If your app has logins, your team can see who's chatting, and the chat follows each user across devices. These guides show the token route and the client code for a Next.js App Router app:

<!-- pages 20-99 -->
