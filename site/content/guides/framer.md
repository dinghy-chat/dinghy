---
title: How to add live chat to a Framer site | Dinghy
nav: Framer
description: Add the Dinghy live chat to a Framer site with one script in Custom Code, set to the end of the body and run once. Then publish and test it live.
date: 2026-11-09
updated: 2026-11-14
order: 5
card: Paste it in Custom Code
logo: framer
---

# Add live chat to Framer

Framer has a Custom Code section in your project settings. Add the Dinghy tag there as a site-wide script at the end of the body, publish, and the chat is on every page.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and, under Allowed sites, add your domain, like `https://www.example.com`. If visitors also reach you at your Framer address, add that one too. The chat only works on sites on the list. Elsewhere the button still shows, but messages don't send.

Connecting your own domain to Framer needs a paid plan.

## Paste the tag

1. Open your project in Framer and go to its settings.
2. Open the Custom Code tab and add a script.
3. Give it a name you'll recognize, like "Dinghy chat".
4. Set the position to the end of the body.
5. Leave the page list empty, so the script runs on the whole site.
6. Set it to run once.
7. Paste the tag and save.
8. Publish the site.

Pick "Once" and not "Run on every page visit". The tag only needs to run once per visit, and the chat stays on screen while visitors move between pages. Running it on every page visit would add the tag again each time.

## Check that it works

Framer doesn't load custom code in the canvas preview, so check the published site. Open it in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

If the button isn't there, check that you published after saving, then open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has the usual causes.

## Things to know

- If your plan has Advanced Hosting and you set a [Content Security Policy header](https://www.framer.com/help/articles/how-to-add-a-content-security-policy/) under Site Settings > Hosting > Headers, allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`.
- The chat sits in its own Shadow DOM, so your Framer styles don't change it and it doesn't change your site.

## Next

- Match the chat to your brand in Settings > Appearance: colors, the chat button, the words and more, with no code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- Open the chat from your own button with `data-launcher="hidden"` and `Dinghy.open()`. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).
