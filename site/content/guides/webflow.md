---
title: How to add live chat to a Webflow site | Dinghy
nav: Webflow
description: Add the Dinghy live chat to Webflow by pasting one tag in your site's footer code, then publish.
date: 2026-11-08
updated: 2026-11-14
order: 3
card: Paste it in the footer code
logo: webflow
---

# Add live chat to Webflow

Webflow has a box for code that goes before `</body>` on every page. Put the Dinghy tag there, publish, and you're done.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

## Add your site to Allowed sites

In Dinghy, open Settings > Install and, under Allowed sites, add your domain, like `https://www.example.com`. If you want the chat on your `webflow.io` staging address too, add `https://your-site.webflow.io` as well.

## Paste the tag

1. In Webflow, open your site's settings.
2. Go to the Custom code tab.
3. Paste the tag in the Footer code box. Webflow puts that code before `</body>` on every page.
4. Save.
5. Publish the site.

Webflow's custom code fields need a paid Site plan. On a free site, Webflow doesn't let you add the code.

## Check that it works

Custom code doesn't run in the Designer preview, so check the published site. Open it in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox.

If the button isn't there, check that you published after saving, then open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included.

## Open the chat from your own button

Maybe your design already has a "Talk to us" button. Add `data-launcher="hidden"` to the tag to hide Dinghy's button. Then give your own button a link to `#chat` and add this script in the Footer code, after the tag:

```html
<script>
  document.addEventListener("click", (e) => {
    if (!e.target.closest('a[href="#chat"]')) return;
    e.preventDefault();
    // Before the chat's script has loaded, the call waits in its queue.
    if (window.Dinghy?.open) Dinghy.open();
    else (window.Dinghy ??= { q: [] }).q?.push(["open"]);
  });
</script>
```

[Add the chat to your site](/docs/add-to-your-site#control-it-from-your-page) has more on `Dinghy.open()`.
