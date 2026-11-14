---
title: How to add live chat to a Wix site | Dinghy
nav: Wix
description: Add the Dinghy live chat to Wix with Custom Code in your site settings, on all pages at the end of the body. You need a connected domain.
date: 2026-11-09
updated: 2026-11-14
order: 7
card: Paste it in Custom Code
logo: wix
---

# Add live chat to Wix

Wix runs your own scripts through Custom Code in the site settings. Add the Dinghy tag there and set it to run on all pages, at the end of the body.

## Before you start

Wix only runs custom code on a published site with a connected domain. Connecting a domain needs a Wix Premium plan. So a free `wixsite.com` site can't have the chat.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and add your connected domain under Allowed sites, like `https://www.example.com`. If people also use the bare domain, add `https://example.com` too. Those are two different sites.

## Paste the tag

1. Open your site's dashboard and go to Settings.
2. Under Development & integrations, select Custom Code.
3. Click the add button at the top right.
4. Paste the tag in the box and name it something like "Dinghy chat".
5. Under Add Code to Pages, pick All pages, and choose to load the code once per visit.
6. Under Place Code in, pick Body - end.
7. Click Apply.

Load it once per visit, not on each page. The chat stays on screen as people move around your site. Loading the tag on every page would add it again each time.

## Check that it works

Open your live site in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

No button? Open your browser's developer console. A script error or a blocked request tells you why, and [Troubleshooting](/docs/troubleshooting#the-chat-widget) lists the usual causes. To rule out another snippet, turn off your other custom code one at a time with its toggle.

## Things to know

- If you assign a different primary domain to your site, Wix deletes your custom code. Add the tag again, and add the new domain to Allowed sites.
- Wix [added new security measures for custom code](https://support.wix.com/en/article/embedding-custom-code-on-your-site) in December 2025, and they can block some snippets. If the chat doesn't load and the console shows Wix blocking it, email `hello@dinghy.chat` with what it says.
- Wix doesn't support problems with third-party code. Ask us, not Wix.

## Next

- Change colors, the chat button and the words in Settings > Appearance. No code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- For a plain chat button, add `data-launcher="bubble"` or set it in Settings > Appearance.
