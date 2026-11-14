---
title: How to add live chat to a Squarespace site | Dinghy
nav: Squarespace
description: Add the Dinghy live chat to Squarespace by pasting one tag in the footer field of Code Injection. Works on the Core, Plus and Advanced plans.
date: 2026-11-09
updated: 2026-11-14
order: 6
card: Paste it in Code Injection
logo: squarespace
---

# Add live chat to Squarespace

Squarespace's Code Injection panel has a footer field that goes before `</body>` on every page. Paste the Dinghy tag there and save. That's the whole install.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and, under Allowed sites, add your domain, like `https://www.example.com`. If people also visit your built-in `squarespace.com` address, add `https://your-site.squarespace.com` too.

## Paste the tag

1. In Squarespace, open the Pages panel, then Website tools, then Code injection.
2. Paste the tag in the Footer field.
3. Click Save.

Squarespace puts footer code before the closing `</body>` tag on every page of your site.

Code injection is part of the Core, Plus and Advanced plans, and some older billing plans. If you don't see the panel, your plan doesn't include it.

## Check that it works

Open your live site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

Squarespace can turn off scripts in the editor preview, and it shows a banner when it does. That only changes what you see while logged in. Visitors still get the chat.

If the button isn't there, open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

## Things to know

- The chat won't appear on checkout pages. Squarespace doesn't allow code there.
- Squarespace support doesn't help with custom code, so if something looks off, ask us at `hello@dinghy.chat`.

## Next

- Match the chat to your site in Settings > Appearance: colors, the chat button, the words and more, with no code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- Open the chat from your own button with `data-launcher="hidden"` and `Dinghy.open()`. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).
