---
title: How to add live chat to any website | Dinghy
nav: Any website
description: Add the Dinghy live chat to a plain HTML site, or any site where you can edit the page. It's one script tag before the closing body tag.
date: 2026-11-09
updated: 2026-11-14
order: 12
card: One line before the closing body tag
logo: html
---

# Add live chat to any website

If you can edit your site's HTML, you can add Dinghy. Paste one script tag before `</body>` on every page that should have the chat. No build step, no framework, no plugin.

## Get your tag

It's in the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

The `data-key` is public. It only names your workspace, so it's fine in your page source and in git.

## Add your site to Allowed sites

In Dinghy, open Settings > Install and add your site's address under Allowed sites, like `https://www.example.com`. One address per line, no path. `https://example.com` and `https://www.example.com` are two different sites, so add both if people use both.

## Paste the tag

Put it just above `</body>`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>My site</title>
  </head>
  <body>
    <h1>Hello</h1>

    <script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
  </body>
</html>
```

Do it on every page. If you have a shared footer or layout file, paste it there once. In Hugo, Jekyll or Eleventy that's the base template or the footer partial.

The script is under 4 KB. The rest of the chat loads when a visitor opens it, or comes back to a chat they started.

## Check that it works

Open your site in a private window. The chat button should be in the bottom right corner. Send a test message and it shows up in your Dinghy inbox.

No button? Open the browser's developer console. If `loader.js` failed, the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but every message says "Not sent", add the exact address you're on to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting#the-chat-widget) has more.

Opening the file straight from your disk won't work. A `file://` page has no address to put in Allowed sites. Serve it from a local server and add that address, like `http://localhost:8000`.

## Make it yours

Add these to the tag:

- `data-primary="#1a1a2e"` and `data-accent="#e5352b"` set your colors. Use full six-digit hex colors.
- `data-launcher="bubble"` swaps the boat for a round chat button. `data-mascot="false"` hides the boat inside the open chat.
- `data-launcher="hidden"` hides the button, so you can open the chat from your own.

With the button hidden, any element can open the chat:

```html
<button id="chat-button">Chat with us</button>
<script>
  document.querySelector("#chat-button").addEventListener("click", () => {
    // Before the chat's script has loaded, the call waits in its queue.
    if (window.Dinghy?.open) Dinghy.open();
    else (window.Dinghy ??= { q: [] }).q?.push(["open"]);
  });
</script>
```

For widget options, unread counts and signed-in users, see [Add the chat to your site](/docs/add-to-your-site).

## If you use a Content Security Policy

Allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`. Use [this policy](/docs/add-to-your-site#if-your-site-has-a-content-security-policy).
