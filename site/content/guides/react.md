---
title: How to add live chat to a React app | Dinghy
nav: React
description: Add Dinghy live chat to a React app built with Vite or an older Create React App setup. The tag goes in index.html, and you open it from any component.
date: 2026-11-09
updated: 2026-11-14
order: 10
card: In index.html, plus your own chat button
logo: react
---

# Add live chat to a React app

In a React single-page app, the chat tag goes in `index.html`, not in a component. It loads once, and the chat stays put while your router changes pages. This guide covers Vite, and older Create React App projects too. For Next.js, see the [Next.js guide](/guides/nextjs).

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Add your site under Allowed sites in Settings > Install, like `https://app.example.com`. For local work, add your dev server too. That's `http://localhost:5173` for Vite and `http://localhost:3000` for Create React App, unless you changed the port.

## Paste it in index.html

With Vite, `index.html` is at the root of your project. With Create React App, it's `public/index.html`. Paste the tag just above `</body>`:

```html
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
    <script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
  </body>
```

That's the install. The build leaves the tag alone, because it points at another address.

Don't add the script from a `useEffect` instead. In development, React's Strict Mode runs effects twice, and each run adds a script. The chat script doesn't check for a copy of itself, so you'd get two chat buttons.

If you'd rather install from npm, the `@dinghy-chat/widget` package adds the tag once, however often it runs, and gives typed calls. See [Install it from npm](/docs/add-to-your-site#install-it-from-npm).

## Route changes

The chat adds itself to `<body>`, outside the element React renders into. When React Router or any other router changes the page, nothing reloads, so the chat stays where it is. An open chat stays open, and a visitor can keep typing while they click around your app.

## Open the chat from a component

The tag adds a `Dinghy` object to the page. Because the script loads with `async`, it might not be there yet when your component first renders. This helper handles both cases. If the script hasn't loaded, it queues the call, and the script runs it when it starts:

```tsx
// src/dinghy.ts
declare global {
  interface Window {
    Dinghy?: { q?: unknown[][]; open?: () => void; close?: () => void };
  }
}

export function openChat() {
  if (window.Dinghy?.open) window.Dinghy.open();
  else (window.Dinghy ??= { q: [] }).q?.push(["open"]);
}
```

Then use it anywhere:

```tsx
import { openChat } from "./dinghy";

export function HelpButton() {
  return <button onClick={openChat}>Chat with us</button>;
}
```

If you'd rather have only your own button, add `data-launcher="hidden"` to the tag in `index.html`. Dinghy's button goes away, and `openChat()` still opens the chat. `Dinghy.on("unread", (count) => ...)` gives you the unread count for your own badge. See [Control it from your page](/docs/add-to-your-site#control-it-from-your-page).

## Show who is chatting

If your app has accounts, your server can sign a short token so the chat follows the user across devices and your team sees who they are. The [Next.js guide](/guides/nextjs#show-who-is-chatting) has a full React example, and the server part works with any backend. The rules for the token are in [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).

When the user signs out, call `Dinghy.reset()` so the next person on that computer can't read the chat.

## If you use a Content Security Policy

Allow your Dinghy address in `script-src`, `connect-src` and `img-src`. Dinghy doesn't need `unsafe-inline`.
