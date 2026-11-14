---
title: Install guides: add live chat to your website | Dinghy
nav: All guides
description: How to add the Dinghy live chat to WordPress, Shopify, Webflow, Wix, Squarespace, Framer, Next.js, React and more. Most of them are one paste.
date: 2026-11-08
updated: 2026-11-14
order: 0
---

# Add live chat to your website

Dinghy is one script tag. So every guide here is the same three steps: get your tag, paste it on every page, and tell Dinghy which site it's on.

## Pick your platform

<!-- pages 1-19 -->

If you can add a script to every page, Dinghy works. [Any website](/guides/html) is the plain version, and [Add the chat to your site](/docs/add-to-your-site) has every option, like colors, your own chat button and signed-in users.

[Claude Code](/guides/claude-code), Cursor or another MCP client can install the chat for you.

## Before you start

If you [self-host](/docs/self-hosting), the installer prints the tag at the end. It's also in the operator app under Settings > Install, and that's where it is on Dinghy Cloud too.

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

The `data-key` is public. It only names your workspace, so it's safe in your page source and in git.

## Add your site to Allowed sites

In Settings > Install, add your site's address under Allowed sites, like `https://www.example.com`. The chat only works on sites on that list. Anywhere else the button still shows, but messages don't send. And `https://example.com` and `https://www.example.com` are two different sites, so add both if people use both.

## Signed-in users

If your app has logins, your team can see who's chatting and the chat follows each user across devices. These guides show the token route and the client code for a Next.js App Router app:

<!-- pages 20-99 -->
