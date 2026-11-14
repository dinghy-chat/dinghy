---
title: How to add live chat to an Astro site | Dinghy
nav: Astro
description: Add the Dinghy live chat to an Astro site with one is:inline script in your base layout. And the fix that keeps it on screen with view transitions.
date: 2026-11-09
updated: 2026-11-14
order: 11
card: Base layout, plus a view transitions fix
logo: astro
---

# Add live chat to Astro

In Astro, the chat tag goes in the layout every page uses. With view transitions, add the swap listeners below to keep the chat on screen.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Add your site under Allowed sites in Settings > Install, like `https://www.example.com`. For local work, add `http://localhost:4321` too. That's Astro's default dev address.

## Paste it in your layout

Open your base layout, usually `src/layouts/Layout.astro`, and paste the tag just above `</body>`. Add `is:inline` so Astro leaves the script alone:

```astro
  <body>
    <slot />
    <script is:inline src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
  </body>
```

If some pages use a different layout, add the tag there too. Without view transitions, you're done. Each page load brings back the chat and its conversation.

## If you use view transitions

With Astro's `<ClientRouter />`, page changes don't reload the page. Astro swaps in the new page's `<body>` instead. The chat lives in the body, so the swap removes it. And Astro won't run the same script twice to bring it back.

Add this after the tag. It moves the chat into the new body after each swap:

```astro
<script is:inline>
  {
    let chat;
    document.addEventListener("astro:before-swap", () => { chat = document.querySelector("dinghy-chat"); });
    document.addEventListener("astro:after-swap", () => { if (chat) document.body.append(chat); });
  }
</script>
```

Astro runs this once too, since it's the same script on every page, so the listeners don't pile up. An open chat stays open when the visitor changes pages.

## Open the chat from your own button

Add `data-launcher="hidden"` to the tag to hide Dinghy's button, then call `Dinghy.open()` from yours:

```astro
<button data-open-chat>Chat with us</button>

<script>
  type Queue = { q?: unknown[][]; open?: () => void };
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("[data-open-chat]")) return;
    const w = window as Window & { Dinghy?: Queue };
    if (w.Dinghy?.open) w.Dinghy.open();
    else (w.Dinghy ??= { q: [] }).q?.push(["open"]);
  });
</script>
```

Astro bundles that script and runs it once. The listener is on `document`, so it still works after a view transition swaps the page.

If someone clicks before the chat script has loaded, the call waits in a queue and runs when it arrives. [Control it from your page](/docs/add-to-your-site#control-it-from-your-page) has the rest.

## Check that it works

Run your site, open it in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox. With view transitions on, click to another page and check the button's still there.

## If you use a Content Security Policy

Allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`. But the view transitions snippet above is an inline script, so a strict policy needs a hash or nonce for it. Or move it into a file you serve yourself.
