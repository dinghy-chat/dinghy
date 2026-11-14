---
title: Live chat for small online stores | Dinghy
nav: Online stores
description: Live chat for small Shopify and WooCommerce stores. Answer pre-sale questions from your phone, swap photos and files in the chat, and pay $7 a month flat.
date: 2026-11-09
updated: 2026-11-14
order: 2
card: Answer pre-sale questions from your phone
---

# Live chat for small online stores

For a small store, live chat is mostly pre-sale questions, like whether it fits or when it ships. Dinghy puts a chat button on your store, lets customers and you send photos and files, and pings your phone when someone writes, so you can answer from wherever you are. Dinghy Cloud is $7 a month for up to 5 people.

## Answer before they leave

Someone asking "will this fit a 15 inch laptop?" is close to buying. The sooner they hear back, the better your odds of keeping the sale.

That's why phone alerts matter more for a store than any other feature. The Dinghy operator app is a web app you add to your phone's home screen, and it sends a push notification when a customer writes.

1. Open your Dinghy address on your phone. On an iPhone, use Safari, select Share, then Add to Home Screen, and open Dinghy from there.
2. Go to Settings > Notifications, turn on Browser notifications, and select Send a test.
3. Do the same on any other phone or computer you answer from. Each device has its own setting.

Phones sometimes delay or drop notifications, so don't treat them as the only alarm. If a customer leaves before you answer, they can leave an email, and your reply goes to their inbox. They can answer from their mail app, and the answer comes back into the same conversation. On Dinghy Cloud that works out of the box. On a self-hosted install, it needs a mail server. The [operator guide](/docs/operator-guide#get-alerts) has the details.

## Photos and files both ways

Customers can paste, drag or pick a photo, like the scratch on the item that arrived or the size label they're unsure about. You can send one back from the inbox, like a close-up of the stitching. Images must be PNG, JPEG or WebP, under 5 MB. Files such as a PDF invoice, a spreadsheet or a short video go up to 10 MB. Customers can send files while Visitors can send files is on in Settings > Appearance.

Dinghy Cloud includes 1 GB of files per workspace, images included, kept for 12 months. Settings > Workspace shows how much you've used.

## Quick answers to the same questions

Save the answers you type every day, like your shipping times or return policy, as saved replies. Type **/** in the reply box to insert one. Labels such as `returns` or `sizing` sort the inbox, and Analytics counts them, with your reply times and busiest hours. Business hours show customers when you're back and ask for their email outside them.

## Add it to your store

It's one tag in your theme, and no app to install.

- [Shopify](/guides/shopify). Paste the tag in `theme.liquid`, just above `</body>`. The chat shows on your store pages but not on Shopify's checkout, which Shopify builds itself.
- [WordPress and WooCommerce](/guides/wordpress). WooCommerce runs on WordPress, so the WordPress guide covers it. Use a header and footer plugin or your child theme.

Add your store's address under Allowed sites in Settings > Install, and your `myshopify.com` address too if customers use it. Match your store's colors in Settings > Appearance.

## Busy season costs the same

Dinghy Cloud doesn't count conversations or contacts. A December with three times the chats costs the same $7 as a quiet February. The plan's limits are 5 people and 1 GB of files. [What other tools cost](/compare/).

## When Dinghy isn't the right fit

- You want order lookups, product cards or cart details inside the chat. Dinghy shows the pages a customer looked at, and facts your page sends with `Dinghy.setContext()`, such as a cart total. It has no order lookups and nothing else from your store's backend.
- You want abandoned-cart messages, pop-ups or campaigns. Dinghy doesn't send messages a customer didn't ask for.
- You want Instagram, WhatsApp or your support email address in the same inbox. Dinghy is website chat, plus email replies to visitors who left.
- You want a ready-made bot to answer "where's my order?" at 3 a.m. with no setup. Dinghy has no AI of its own. If you build or run your own bot, it can answer through MCP or the API, with its replies waiting as drafts for you by default. See [Live chat for AI agents](/for/ai-agents).
- You can't reply for hours at a time. A contact form may serve customers better than a chat that looks live and isn't.

## Get started

[Start on Dinghy Cloud](https://app.dinghy.chat/signup) for $7 a month, or [host it yourself](/docs/self-hosting) for free. Then follow the [Shopify guide](/guides/shopify) or the [WordPress guide](/guides/wordpress).
