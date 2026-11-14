---
title: How to add live chat to a Shopify store | Dinghy
nav: Shopify
description: Add the Dinghy live chat to your Shopify store by pasting one tag in theme.liquid. There's no app to install.
date: 2026-11-08
updated: 2026-11-14
order: 2
card: One paste in theme.liquid
logo: shopify
---

# Add live chat to Shopify

You paste one tag into one file and the chat is on every page of your store.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your store to Allowed sites

In Dinghy, open Settings > Install and add your store's address under Allowed sites, like `https://shop.example.com`. If customers also reach you at your `myshopify.com` address, add `https://your-store.myshopify.com` too. The chat only works on sites on the list. Anywhere else the button still shows, but messages don't send.

## Paste the tag in your theme

1. In your Shopify admin, go to Online Store.
2. Next to your current theme, click the three dots and pick Duplicate. That's your backup.
3. Click the three dots again and pick Edit code.
4. In the Layout folder, open `theme.liquid`.
5. Find `</body>` near the bottom of the file. Paste your tag on the line just above it.
6. Click Save.

```liquid
    <script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
  </body>
</html>
```

## Check that it works

Open your store in a private window. The chat button should be in the corner. Send a test message and it shows up in your Dinghy inbox.

The chat won't show on Shopify's checkout pages. Shopify builds those itself and they don't use your theme's layout.

## Things to know

- If you switch themes later, paste the tag into the new theme's `theme.liquid` too.
- A theme update can drop code edits that clash with the new version. After an update, check the chat's still there.
- You can't edit the code of a paid theme while you're on a free trial of it. Buy it first.

## Make it fit your store

Set your colors, the chat button and the words in Settings > Appearance. No code. Colors on the tag, like `data-primary="#1a1a2e"`, win over the setting. [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks) lists every option.
