---
title: Live chat for SaaS products | Dinghy
nav: SaaS products
description: Live chat for a SaaS app that knows which signed-in user is asking, opens from your own Help menu, and costs $7 a month for up to 5 people.
date: 2026-11-09
updated: 2026-11-14
order: 1
card: Know which signed-in user is asking
---

# Live chat for SaaS products

For a SaaS app, Dinghy gives your users a chat that knows who they are. Your server signs a short token, and your team sees the user's email, their ID in your app and anything else you send, like their plan. A web address you send shows as a link, so one click takes you to the user in your admin. You can open the chat from your own Help menu instead of a floating button. Dinghy Cloud costs $7 a month for up to 5 people.

## Know who is asking

Without any setup, a visitor is anonymous, and their chat lives in that browser. That's fine on a marketing site. Inside your app, you already know who the user is, so tell Dinghy.

1. Copy the signing secret from Identify signed-in users (optional) in Settings > Install, and keep it on your server.
2. Add a route that signs a token for the current user, with their ID, their email and any attributes your team should see, like their plan.
3. On the page, call `Dinghy.identify()` with a function that fetches that token. The widget calls it again when the token expires.
4. Call `Dinghy.reset()` when the user signs out.

The chat then follows the user to every device they sign in on. A `name` claim becomes the conversation's title in the inbox, so you see "Ana at Acme" instead of a random visitor. The [Next.js guide](/guides/nextjs#show-who-is-chatting) has a full route handler and client component, and [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting) lists every field the token takes. Any JWT library works, in any language.

## Open it from your Help menu

A chat bubble over your app's UI can get in the way. Hide it with `data-launcher="hidden"` on the tag, and open the chat from your own menu:

```html
<script>
  // Show unread replies on your own menu item.
  window.Dinghy = { q: [["on", "unread", (count) => {
    document.querySelector("#help-badge").textContent = count || "";
  }]] };
</script>
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" data-launcher="hidden" async></script>
```

```js
document.querySelector("#help-chat").addEventListener("click", () => Dinghy.open());
```

The script loads with `async`, so `Dinghy` may not exist yet when your page code runs. That's why the unread listener goes in a queue before the tag. The click handler only runs when someone clicks, and by then the script is there. [Control it from your page](/docs/add-to-your-site#control-it-from-your-page) has the other calls and events, and `Dinghy.setContext()` passes page facts, like the screen the user is on. Set your brand colors and a light, dark or automatic theme in Settings > Appearance so it looks like part of your app. In a React or Next.js app, the npm package `@dinghy-chat/widget` adds the tag for you, with types.

## It stays out of your bundle

The tag loads a script under 4 KB. Signed-in users get the full chat as soon as your page calls `identify`, even if they never open it, and it's under 27 KB gzipped. It renders in its own Shadow DOM, so your CSS can't break it and its CSS can't touch your app. If you run a Content Security Policy, allow your Dinghy address in `script-src`, `connect-src` and `img-src`. It doesn't need `unsafe-inline`.

## The price doesn't grow with the team

Dinghy Cloud is $7 a month per workspace, flat, for up to 5 people and 1 GB of files. Bring in a second founder, then a support hire, then an engineer on rotation, and the price stays at $7. Dinghy doesn't count conversations, contacts or users. [What other chat tools cost at 1, 3 and 5 people](/compare/).

## When Dinghy isn't the right fit

- More than 5 people answer chats. Dinghy Cloud stops at 5. You can self-host with no limit, but then you run the server.
- You want product tours, in-app announcements, email campaigns or a help center. Dinghy has none of these. Intercom does, at a higher price. See [Dinghy vs Intercom](/compare/intercom).
- You want a hosted AI agent that answers first with no setup, trained on your help center. Dinghy has no AI of its own. Your own agent can answer through MCP or the API, with a person approving its drafts by default. See [Live chat for AI agents](/for/ai-agents) and [why we work this way](/blog/bring-your-own-ai-agent).
- You need a native mobile SDK. The widget is for websites and web apps.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. Then follow the [Next.js guide](/guides/nextjs) or [Add the chat to your site](/docs/add-to-your-site).
