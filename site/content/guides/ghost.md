---
title: How to add live chat to a Ghost site | Dinghy
nav: Ghost
description: Add the Dinghy live chat to a Ghost publication by pasting one tag in Code injection's Site footer. No theme edits, and it works with any theme.
date: 2026-11-09
updated: 2026-11-14
order: 8
card: Paste it in Code injection
logo: ghost
---

# Add live chat to Ghost

Ghost has a Code injection setting with a Site footer box. Code there goes before `</body>` on every page, whatever theme you use. Paste the Dinghy tag in it and save.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and, under Allowed sites, add your publication's address, like `https://blog.example.com`. If readers also reach you at a `ghost.io` address, add that one too.

## Paste the tag

1. In Ghost admin, open Settings.
2. Go to Advanced, then Code injection.
3. Paste the tag in the Site footer box.
4. Save.

Use Site footer, not Site header. Ghost suggests the footer for scripts, and the tag is `async` anyway, so it never holds up your posts.

## Check that it works

Open your site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

If the button isn't there, open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

## Things to know

- Code injection lives in Ghost's settings, not in your theme, so switching or updating themes keeps the chat.
- Ghost also has code injection on single posts and pages. Use that if you only want the chat on, say, your pricing or contact page.
- If you also run Ghost members, readers stay anonymous in the chat unless your own server signs a token for them. Plain Ghost doesn't do that, so expect anonymous chats.

## Next

- Match the chat to your theme in Settings > Appearance: colors, the chat button, the words and more, with no code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- Pick a plain chat button with `data-launcher="bubble"`, or set it in Settings > Appearance.
