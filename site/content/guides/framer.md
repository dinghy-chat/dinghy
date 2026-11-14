---
title: How to add live chat to a Framer site | Dinghy
nav: Framer
description: Add the Dinghy live chat to a Framer site with one script in Custom Code, at the end of the body, set to run once. Then publish and test it live.
date: 2026-11-09
updated: 2026-11-14
order: 5
card: Paste it in Custom Code
logo: framer
---

# Add live chat to Framer

Framer's project settings have a Custom Code section. Add the Dinghy tag there as a site-wide script at the end of the body, publish, and the chat is on every page.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and add your domain under Allowed sites, like `https://www.example.com`. If people also reach you at your Framer address, add that one too. The chat only works on sites on the list. Anywhere else the button still shows, but messages don't send.

You need a paid Framer plan to connect your own domain.

## Paste the tag

1. Open your project in Framer and go to its settings.
2. Open the Custom Code tab and add a script.
3. Name it something you'll recognize, like "Dinghy chat".
4. Set the position to the end of the body.
5. Leave the page list empty, so it runs on the whole site.
6. Set it to run once.
7. Paste the tag and save.
8. Publish the site.

Pick "Once", not "Run on every page visit". The tag only needs to run once per visit, and the chat stays on screen while people move between pages. Otherwise, each page visit adds the tag again.

## Check that it works

Framer doesn't load custom code in the canvas preview, so test the published site. Open it in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

No button? Check you published after saving, then open the browser's developer console. If `loader.js` failed, the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but every message says "Not sent", add the exact address you're on to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has the usual causes.

## Things to know

- If your plan has Advanced Hosting and you set a [Content Security Policy header](https://www.framer.com/help/articles/how-to-add-a-content-security-policy/) under Site Settings > Hosting > Headers, allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`.
- The chat runs in its own Shadow DOM. Your Framer styles don't touch it, and it doesn't touch your site.

## Next

- Change colors, the chat button and the words in Settings > Appearance. No code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- To open the chat from your own button, use `data-launcher="hidden"` and `Dinghy.open()`. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).
