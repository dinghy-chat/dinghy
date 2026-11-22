---
title: Live chat and website analytics without cookies | Dinghy
nav: Website analytics without cookies
description: See who is waiting for a reply now, then compare visits, page views and chat rates over time. Here's what Dinghy counts and what it stores.
date: 2026-11-22
order: 1
card: Live visitors, support metrics and what the widget stores
---

# What live chat analytics can tell you without cookies

If you need to answer someone now, open **Visitors**. If you want to see whether more people asked for help this month, open **Analytics**. Both use the chat widget already on your site.

## See who's waiting now

In **Visitors**, choose **Waiting**. You can see how long each person has waited and open their conversation. Switch to **Everyone** to see the pages open now, the countries visitors connect from and their referring sites when available. These are live tabs. One person can have more than one open.

## Compare site traffic and chat volume

In **Analytics > Your site**, pick 7, 30 or 90 days. The page shows visits, page views, chat rate, peak live traffic, top pages and top referring sites. Chat rate divides the number of conversations that visitors started by the number of visits. A comparison with the previous period appears once you have enough history for both periods.

Open **Conversations** for support numbers such as reply times, volume and busy hours. If traffic is steady but replies take longer, check when conversations arrive. If visits rose but chats stayed flat, look at the pages and sources that brought in the traffic. These are workspace totals. They do not tell you which individual session led to a purchase.

## What the widget sends

A page sends a small presence request when it loads and about once a minute while its tab is visible. It includes the page address without its query string or fragment, the title, and a temporary tab ID. The first request also carries the referring site's origin when the browser provides it. The server looks up the country from the request's IP address. Live tab data expires 90 seconds after its last request.

Dinghy retains hourly site totals for 182 days. Those totals carry no cookie or persistent visitor ID. The conversation count comes from chats visitors started, and the live tab data is separate from those totals.

A visitor who sends a chat message gets a browser token so they can continue after a reload. A site can also identify a signed-in user or make a contact from its server. Those records serve the conversation and contact features.

- [What the widget sends and keeps](/for/privacy)
- [How to read the Analytics screens](/docs/operator-guide#see-how-support-is-going)
- [Install the chat widget](/guides/)
