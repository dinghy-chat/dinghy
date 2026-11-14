---
title: How to add live chat to an Astro site | Dinghy
nav: Astro
description: Add the Dinghy live chat to an Astro site with one is:inline script in your base layout. Plus the fix that keeps it on screen with view transitions.
date: 2026-11-09
updated: 2026-11-14
order: 11
card: Base layout, plus a view transitions fix
logo: astro
---

# Add live chat to Astro

In Astro, the chat tag goes in the layout that every page uses. If your site uses view transitions, add a few more lines so the chat survives page changes.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Add your site under Allowed sites in Settings > Install, like `https://www.example.com`. For local work, add `http://localhost:4321` too, which is Astro's default dev address.

## Paste it in your layout

Open your base layout, often `src/layouts/Layout.astro`, and paste the tag just above `</body>`. Add `is:inline` so Astro leaves the script exactly as it is:

```astro
  <body>
    <slot />
    <script is:inline src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
  </body>
```

If some pages don't use that layout, add the tag to their layout too. Without view transitions, that's all. Each page is a normal page load, and the chat comes back on each one, with the conversation intact.

## If you use view transitions

With Astro's `<ClientRouter />`, page changes don't reload the page. Astro swaps in the new page's `<body>` instead. The chat adds itself to the body, so the swap would remove it, and Astro won't run the same script a second time to bring it back.

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

Astro only runs this once too, since it's the same script on every page, so the listeners don't pile up. Because the same chat moves across, an open chat stays open while the visitor clicks around.

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

Astro bundles that script and runs it once, and the listener sits on `document`, so it keeps working after view transitions swap the page.

If someone clicks before the chat script has loaded, the call waits in a queue and runs once it arrives. [Control it from your page](/docs/add-to-your-site#control-it-from-your-page) has the rest.

## Check that it works

Run your site, open it in a private window, click the chat button and send a test message. It shows up in your Dinghy inbox. With view transitions on, click to another page and check that the button is still there.

## If you use a Content Security Policy

Allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`. The view transitions snippet above is an inline script, so a strict policy needs a hash or nonce for it, or move it into a file you serve yourself.
