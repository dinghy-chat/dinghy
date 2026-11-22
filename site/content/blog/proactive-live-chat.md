---
title: Proactive live chat: offer help on your pricing page | Dinghy
nav: Proactive live chat
description: Show a chat message after someone spends 20 seconds on your pricing page. Test the campaign, read its results and learn when to use a server event.
date: 2026-11-22
order: 1
card: A pricing-page prompt, from the first test to the reply
---

# Proactive live chat on your pricing page

Want to offer help on your pricing page? Show a little card above the chat button after 20 seconds. The visitor can keep reading or reply if they have a question.

## Set up the message

Install the [live chat widget](/live-chat-widget) first and add your site to **Allowed sites** under **Settings > Install**. Then open **Campaigns** as a workspace owner or admin.

1. Create a draft. Name it **Help on the pricing page**.
2. Choose the page trigger. Enter `/pricing` for that exact path, or `/pricing*` if you also have pages below it. Set the wait to 20 seconds.
3. Leave the audience open to everyone and leave variants off. This allows the prompt to reach visitors who have never chatted.
4. Write one question. For example, “Switching from another chat tool? Ask us what you can bring over.”
5. Choose a preview card and set the conversation to start on reply. Leave email off.
6. Select **Send me a test** to check the message. Then select **Go live** and confirm the trigger.

Open the published pricing page in a private window. Wait 20 seconds, then reply to the card. The inbox shows the campaign message followed by your reply. Repeat on a different page to check the path rule. The card can show again after a full page reload, so check that behavior on the site where you run it.

## Read the results

Open the campaign's **Results**. See how many people read, replied to or dismissed the card. If people ask about importing their old conversations, answer that question on the pricing page itself.

To stop the prompt, pause the campaign. You can change the text or timing and resume it. **Pause all campaigns** stops sends from every campaign in the workspace.

## When a page is the wrong trigger

If your app knows a customer's export just finished, have your server report an event such as `export.finished`. An event campaign can send a message to the matching contact. If your code already picks the person and the exact message, use the outbound messages API for a single send.

- [Campaign triggers, audiences and results](/docs/campaigns)
- [Send one outbound message with the API or SDK](/docs/outbound-messages)
- [Set up chat for signed-in SaaS users](/for/saas)
