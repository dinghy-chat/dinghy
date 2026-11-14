---
title: How to add live chat with Google Tag Manager | Dinghy
nav: Google Tag Manager
description: Add the Dinghy live chat through Google Tag Manager with a Custom HTML tag on the All Pages trigger. Plus what to check for consent tools and CSP.
date: 2026-11-09
updated: 2026-11-14
order: 9
card: A Custom HTML tag on all pages
logo: googletagmanager
---

# Add live chat with Google Tag Manager

If Google Tag Manager is already on your site, you can add Dinghy without touching the site's code. It's one Custom HTML tag that fires on all pages.

Pasting the tag straight into your site is still the simpler option when you can. It loads a little sooner and has one less thing in the way.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install. You need two values from it, the script address and the `data-key`:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Then open Settings > Install in Dinghy and add your site under Allowed sites, like `https://www.example.com`.

## Why you can't paste the tag as is

Tag Manager [strips custom attributes](https://www.simoahava.com/analytics/add-html-elements-page-programmatically/) like `data-key` from elements in a Custom HTML tag. Without its key, the chat doesn't start. So the tag below builds the script element in JavaScript and sets the key on it before adding it to the page:

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

Swap in your own script address and key. Other options go the same way, like `s.setAttribute("data-primary", "#1a1a2e");`.

## Create the tag

1. In Tag Manager, open your container and go to Tags.
2. Click New, then Tag Configuration, and pick Custom HTML.
3. Paste the code above. Leave "Support document.write" off, since Dinghy doesn't use it.
4. Under Triggering, pick All Pages.
5. Name the tag, like "Dinghy chat", and save it.
6. Click Submit, then Publish.

## Check that it works

Use Tag Manager's Preview mode to see that the tag fires on page view. Then open your live site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

If the tag fires but no button appears, open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

## Consent tools

If your consent banner holds back tags until a visitor accepts, it may hold back the chat too. Then visitors who haven't clicked the banner don't see the chat button. Check which category your consent setup puts the Dinghy tag in, and whether that's what you want.

Dinghy keeps a visitor's chat in the browser so it's still there after a refresh. It has no website analytics and no ad tracking. Whether the chat needs consent where you are is your call, so ask whoever handles privacy for your site.

## Content Security Policy

If your site sends a Content Security Policy, two things need to be allowed.

1. Your Dinghy address, in `script-src`, `connect-src` and `img-src`. That's the same as for the direct tag. See [the policy to use](/docs/add-to-your-site#if-your-site-has-a-content-security-policy).
2. Tag Manager's own scripts, including the inline Custom HTML tag above. Google's guide to Tag Manager with a CSP recommends a nonce on the container snippet, which Tag Manager then passes on to the scripts it adds.

The direct tag doesn't need `unsafe-inline` or a nonce. If your policy is strict, that's a good reason to skip Tag Manager for the chat.

## Next

- Open the chat from your own button with `data-launcher="hidden"` and `Dinghy.open()`. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).
- If your site has logins, showing which user is chatting needs code on your server. See [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).
