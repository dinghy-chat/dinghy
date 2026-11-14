---
title: How to add live chat with Google Tag Manager | Dinghy
nav: Google Tag Manager
description: Add the Dinghy live chat through Google Tag Manager with a Custom HTML tag on the All Pages trigger. And what to check for consent tools and CSP.
date: 2026-11-09
updated: 2026-11-14
order: 9
card: A Custom HTML tag on all pages
logo: googletagmanager
---

# Add live chat with Google Tag Manager

If Google Tag Manager is already on your site, you can add Dinghy without touching the site's code. It's one Custom HTML tag that fires on all pages.

But if you can paste the tag straight into your site, do that instead. The direct tag doesn't have to wait for Tag Manager.

## Get your tag

It's in the Dinghy operator app, under Settings > Install. You need two values from it, the script address and the `data-key`:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Then open Settings > Install in Dinghy and add your site under Allowed sites, like `https://www.example.com`.

## Why you can't paste the tag as is

Tag Manager [strips custom attributes](https://www.simoahava.com/analytics/add-html-elements-page-programmatically/) like `data-key` from elements in a Custom HTML tag. So the tag below builds the script element in JavaScript and sets the key on it before adding it to the page:

```html
<script>
  (function () {
    var s = document.createElement("script");
    s.src = "https://chat.example.com/widget/loader.js";
    s.async = true;
    s.setAttribute("data-key", "wk_your_public_key");
    document.head.appendChild(s);
  })();
</script>
```

Put in your own script address and key. Other options work the same way, like `s.setAttribute("data-primary", "#1a1a2e");`.

## Create the tag

1. In Tag Manager, open your container and go to Tags.
2. Click New, then Tag Configuration, and pick Custom HTML.
3. Paste the code above. Leave "Support document.write" off. Dinghy doesn't use it.
4. Under Triggering, pick All Pages.
5. Name the tag, like "Dinghy chat", and save it.
6. Click Submit, then Publish.

## Check that it works

Use Tag Manager's Preview mode to check the tag fires on page view. Then open your live site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

If the tag fires but there's no button, open the browser's developer console. If `loader.js` failed, the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but every message says "Not sent", add the exact address you're on to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

## Consent tools

If your consent banner holds back tags until a visitor accepts, it may hold back the chat too. Then people who haven't clicked the banner don't see the chat button. Check which consent category the Dinghy tag uses and whether that blocks the chat before consent.

Dinghy keeps a visitor's chat in the browser so it's still there after a refresh. It sets no cookies and does no ad tracking. For the live visitor list, each open tab tells your Dinghy server which page it's on, and the server keeps that only for visitors who chatted. Ask whoever handles privacy for your site whether the chat needs consent.

## Content Security Policy

If your site sends a Content Security Policy, you need to allow two things.

1. Your Dinghy address, in `script-src`, `connect-src` and `img-src`. Same as for the direct tag. See [the policy to use](/docs/add-to-your-site#if-your-site-has-a-content-security-policy).
2. Tag Manager's own scripts, including the inline Custom HTML tag above. Google's guide to Tag Manager with a CSP recommends a nonce on the container snippet, and Tag Manager then passes it on to the scripts it adds.

The direct tag doesn't need `unsafe-inline` or a nonce. With a strict policy, use the direct tag.

## Next

- To open the chat from your own button, use `data-launcher="hidden"` and `Dinghy.open()`. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).
- If your site has logins, showing which user is chatting needs code on your server. See [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).
