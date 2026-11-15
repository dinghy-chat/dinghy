---
title: How to add live chat to a Ghost site | Dinghy
nav: Ghost
description: Add the Dinghy live chat to a Ghost publication by pasting one tag in Code injection's Site footer. No theme edits, works with any theme.
date: 2026-11-09
updated: 2026-11-14
order: 8
card: Paste it in Code injection
logo: ghost
---

# Add live chat to Ghost

Paste the Dinghy tag in Code injection > Site footer and save. Ghost adds it before `</body>` on every page, with any theme.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and add your publication's address under Allowed sites, like `https://blog.example.com`. If readers also reach you at a `ghost.io` address, add that too.

## Paste the tag

1. In Ghost admin, open Settings.
2. Go to Advanced, then Code injection.
3. Paste the tag in the Site footer box.
4. Save.

Use Site footer, not Site header. Ghost recommends the footer for scripts. And the tag is `async` anyway, so it never holds up your posts.

## Check that it works

Open your site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

No button? Open the browser's developer console. If `loader.js` failed, the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but every message says "Not sent", add the exact address you're on to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

## Things to know

- Code injection is in Ghost's settings, not your theme. Switching or updating themes keeps the chat.
- Ghost also has code injection on single posts and pages. Use that if you only want the chat on, say, your pricing or contact page.
- If you run Ghost members, readers are anonymous in the chat unless your own server signs a token for them. Plain Ghost doesn't do that, so expect anonymous chats.

## Next

- Change colors, the chat button and the words in Settings > Appearance. No code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- For a plain chat button, add `data-launcher="bubble"` or set it in Settings > Appearance.
