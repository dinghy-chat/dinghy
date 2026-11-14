---
title: Live chat for small online stores | Dinghy
nav: Online stores
description: Live chat for small Shopify and WooCommerce stores. Answer pre-sale questions from your phone, send photos both ways, and pay $7 a month flat.
date: 2026-11-09
updated: 2026-11-14
order: 2
card: Answer pre-sale questions from your phone
---

# Live chat for small online stores

On a small store, most chats are pre-sale questions. Does it fit? When does it ship? Dinghy adds a chat button to your store, you and your customers can send photos and files, and your phone buzzes when someone writes. Dinghy Cloud is $7 a month for up to 5 people.

## Answer before they leave

Someone asking "will this fit a 15 inch laptop?" is about to buy. The longer they wait, the more likely they close the tab.

The Dinghy operator app is a web app you add to your phone's home screen, and it sends a push notification when a customer writes.

1. Open your Dinghy address on your phone. On an iPhone, use Safari, select Share, then Add to Home Screen, and open Dinghy from there.
2. Go to Settings > Notifications, turn on Browser notifications, and select Send a test.
3. Do the same on every other phone or computer you answer from. Each device has its own setting.

Phones sometimes delay or drop notifications, so don't rely on them alone. If a customer leaves before you answer, they can leave an email, and your reply goes to their inbox. They answer from their mail app and it comes back into the same conversation. On Dinghy Cloud, it's already set up. Self-hosted, you need a mail server, plus an inbound address for [replies by email](/docs/self-hosting#replies-by-email). The [operator guide](/docs/operator-guide#get-alerts) has the details.

## Photos and files both ways

Customers can paste, drag or pick a photo. The scratch on the item that arrived, the size label they're not sure about. And you can send one back from the inbox, like a close-up of the stitching. Images must be PNG, JPEG or WebP, under 5 MB. Other files, like a PDF invoice, a spreadsheet or a short video, go up to 10 MB. Customers can send files as long as Visitors can send files is on in Settings > Appearance.

Dinghy Cloud gives you 1 GB of files per workspace, images included, kept for 12 months. Settings > Workspace shows how much you've used.

## Quick answers to the same questions

Save your shipping times and return policy as saved replies. Type **/** in the reply box to insert one. Labels like `returns` or `sizing` sort the inbox, and Analytics counts them, next to your reply times and busiest hours. Business hours tell customers when you're back, and ask for their email when you're closed.

## Add it to your store

It's one tag in your theme. No app to install.

- [Shopify](/guides/shopify). Paste the tag in `theme.liquid`, just above `</body>`. The chat shows on your store pages but not on Shopify's checkout, because Shopify builds that page itself.
- [WordPress and WooCommerce](/guides/wordpress). WooCommerce runs on WordPress, so the WordPress guide covers it. Use a header and footer plugin or your child theme.

Add your store's address under Allowed sites in Settings > Install. Add your `myshopify.com` address too if customers use it. Set your store's colors in Settings > Appearance.

## Busy season costs the same

Dinghy Cloud doesn't count conversations or contacts. December with three times the chats costs the same $7 as a quiet February. The limits are 5 people and 1 GB of files. [What other tools cost](/compare/).

## When Dinghy isn't the right fit

- You want order lookups, product cards or cart details in the chat. Dinghy shows the pages a customer looked at, and facts your page sends with `Dinghy.setContext()`, like a cart total. That's it. No order lookups, nothing else from your store's backend.
- You want abandoned-cart messages, pop-ups or campaigns. Dinghy doesn't send messages a customer didn't ask for.
- You want Instagram, WhatsApp or your support email in the same inbox. Dinghy is website chat, plus email replies to visitors who left.
- You want a ready-made bot that answers "where's my order?" at 3 a.m. with no setup. Dinghy has no AI of its own. If you build or run your own bot, it can answer through MCP or the API, and by default its replies wait as drafts for you. See [Live chat for AI agents](/for/ai-agents).
- You can't reply for hours at a time. Use a contact form.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. Then follow the [Shopify guide](/guides/shopify) or the [WordPress guide](/guides/wordpress).
