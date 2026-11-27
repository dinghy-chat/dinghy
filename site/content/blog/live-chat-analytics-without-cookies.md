---
title: Live chat and website analytics without cookies | Dinghy
nav: Website analytics without cookies
description: See who’s waiting for a reply. Check visits, page views and chat rates, and see what Dinghy stores to count them.
date: 2026-11-22
order: 1
card: Live visitors, support metrics and what the widget stores
image: live-chat-analytics-without-cookies
---

# What live chat analytics can tell you without cookies

Open **Visitors** to see who’s waiting for an answer. Open **Analytics** to see how busy the inbox was this month. Both use the chat widget already on your site.

## See who's waiting now

In **Visitors**, choose **Waiting**. You can see how long each person has waited and open their conversation. Switch to **Everyone** to see the pages open now, the countries visitors connect from and their referring sites when available. These are live tabs. One person can have more than one open.

## Compare site traffic and chat volume

In **Analytics > Your site**, pick 7, 30 or 90 days. The page shows visits, page views, chat rate, peak live traffic, top pages and top referring sites. Chat rate divides the number of conversations that visitors started by the number of visits. A comparison with the previous period appears once you have enough history for both periods.

![Chat rate is the number of conversations that visitors started divided by the number of visits, for a period of 7, 30 or 90 days.](/img/illustrations/live-chat-analytics-without-cookies-chat-rate.png)

Open **Conversations** for support numbers such as reply times, volume and busy hours. If traffic is steady but replies take longer, check when conversations arrive. If visits rose but chats stayed flat, look at the pages and sources that brought in the traffic. These are totals for the workspace. There’s no purchase attribution.

## What the widget sends

A page sends a small presence request when it loads and about once a minute while its tab is visible. It includes the page address without its query string or fragment, the title, and a temporary tab ID. The first request also carries the referring site's origin when the browser provides it. The server looks up the country from the request's IP address. Live tab data expires 90 seconds after its last request.

![A visible tab sends a small presence request about once a minute with the page address minus its query string, the title and a temporary tab ID; live data expires after 90 seconds, hourly totals stay 182 days, and nothing uses cookies.](/img/illustrations/live-chat-analytics-without-cookies-presence.png)

Dinghy keeps hourly site totals for 182 days. The widget uses no cookies, and the totals have no persistent visitor ID. The conversation count comes from chats visitors started, and the live tab data is separate from those totals.

A visitor who sends a chat message gets a browser token so they can continue after a reload. A site can also identify a signed-in user or make a contact from its server.

- [What the widget sends and keeps](/for/privacy)
- [How to read the Analytics screens](/docs/operator-guide#see-how-support-is-going)
- [Install the chat widget](/guides/)
