---
title: Chatbot vs live chat for a small team, and what AI costs
nav: Chatbot vs live chat
description: When a chatbot helps a small team, when it annoys visitors, what AI answers cost per resolution in 2026, and the middle path where a bot drafts and a person sends.
date: 2026-11-27
updated: 2026-11-27
priceChecked: 2026-11-27
order: 50
card: When a bot helps, when it annoys, and what each answer costs
---

# Chatbot vs live chat for a small team

For a team of one to five people, start with live chat. Questions about an account, a bill or whether your product fits are where a person wins the customer. A bot earns its place on the routine ones, such as where you ship or how to reset a password, especially at night when nobody's around.

![Two sailboats head for the same buoy, one steered by a robot and one by a person](/img/illustrations/chatbot-vs-live-chat.png)

So the question isn't really bot or chat. It's how much of the answering you hand to a bot, and what you pay for each answer.

## Where a bot helps

A bot is good at questions that have one right answer, written down somewhere, that people ask over and over:

- "Do you ship to Canada?"
- "How do I reset my password?"
- "Is there an annual plan?"
- "Where's the API documentation?"

If you can paste the answer from a saved reply without changing a word, a bot can give it too. It answers at 3 a.m. on a Sunday, and the visitor doesn't wait for your time zone.

A bot also helps when your team is one person who's in meetings all day. It can collect the details you'd ask for anyway, such as the order number, the account email and what they already tried, so your first reply can fix the problem.

## Where a bot annoys people

A bot annoys people when it stands between them and a human. It goes wrong in a few common ways:

- The question is about their account, and the bot can't see the account.
- The visitor is angry about a charge. A cheerful "I can help with that!" makes it worse.
- The bot answers a question that's close to the one they asked. They ask again, get the same answer, and leave.
- There's no visible way to reach a person, or the way is "type 'agent' three times".
- The bot invents a feature or a refund policy. Now you owe someone an apology and maybe money.

For a small company, the last one matters most. Your visitors chat with you because you're small. They expect the founder or someone close to them. A bot that guesses wrong costs you the trust that made them write in the first place.

## What AI answers cost

What you pay depends on what the vendor counts. Some charge per outcome or resolution, and others include a pool of AI credits in the plan. Here's what four of them list today.

| Vendor | What you pay for AI | Unit |
|---|---|---|
| [Intercom Fin](https://www.intercom.com/pricing) | $0.99 per outcome, plus seats | At most one charge per conversation. A [configured handoff](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes) to a person also counts, and a booked sales call or trial costs $9.99 |
| [Zendesk](https://www.zendesk.com/pricing/) | The pricing page lists $1.50 per committed automated resolution or $2.00 pay as you go, plus seats | 5 included a month per agent on Team. Accounts on Zendesk's newer billing get a [dollar allowance](https://support.zendesk.com/hc/en-us/articles/10479587390106-Managing-resolution-allowances) instead, $2 per agent seat a month on Team |
| [Crisp](https://crisp.chat/en/pricing/) | $5 of AI credits included in Mini at $45 a month per workspace | Crisp says that's around 90 automated conversations |
| [Chatwoot](https://www.chatwoot.com/pricing) | 300 Captain credits with Startups at $19 per agent a month, then $20 per 1,000 credits | Credits, not conversations |

Intercom also offers Fin on top of another helpdesk, with no seat cost but a minimum monthly commitment, and its page gives 50 outcomes as an example. [Tidio](https://www.tidio.com/pricing/) doesn't price Lyro per answer on its self-serve plans. Its Starter plan with Lyro is $390 billed annually for 50 AI and human conversations a month, and its page says the AI plans cost more than Human only for the same quota.

Take a team with 200 chats a month where the bot resolves half. On Intercom, those 100 resolutions cost $99 a month before seats. If Fin also hands off the other 100 through a configured procedure, that's $198. At Zendesk's listed pay-as-you-go rate, it's up to $200, less what your plan includes. If your account has the dollar allowance, ask Zendesk for your rates. Either way the bill grows with your traffic, so a busy launch month raises it. Zendesk lets you pause the bot when the allowance runs out, which caps the bill but leaves visitors with no bot.

Read what counts before you compare rates. [Intercom](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes) counts a resolution when the customer doesn't ask for more help after Fin's last answer, and also bills the handoffs and sales outcomes above. Zendesk's [newer tiers](https://support.zendesk.com/hc/en-us/articles/9570369117338-About-automated-resolution-tiers) count only resolutions that pass an extra check by its own AI. Per-resolution pricing gives the vendor a reason to call a conversation resolved, so the definition matters as much as the price.

## Let the bot draft and a person send

There's a third option. The bot writes a draft, and someone on your team reads it, fixes it if needed, and sends it.

A draft saves time when checking it is faster than writing the answer yourself. For a question you've answered fifty times, it usually is. And the visitor only sees what someone on your team sends. Check any fact or promise in a draft before you hit send. If you have to look up every detail anyway, skip the draft, write the reply yourself and save it for next time.

Reading every draft only works while the volume is small. At 200 chats a month, that's fine. At 20,000 it isn't, which is why big vendors sell full automation.

If you want the bot to answer shipping questions on its own, build it to hand everything else to a person, and test that handoff before you switch on direct replies.

## How Dinghy does it

Dinghy has no AI of its own and charges no AI fee. You connect your own agent through Dinghy's [MCP server or HTTP API](/docs/agents), and what the model costs is between you and the provider you pick. Nobody bills you per resolution.

A new key or connection starts in **Drafts only**. The agent's reply waits under the last message as a pale suggestion, marked with the bot's name, and the visitor can't see it. Someone on your team clicks **Send**, **Edit** or **Discard**. If your agent handles rewrite requests, turn on **This bot can rewrite drafts**, and an operator can type "shorter" or "answer in Spanish" under a draft to get a new one.

When the drafts read well, an owner or admin switches the key or connection to **Send directly**. That applies to every reply it sends, so the agent itself has to decide which questions to leave to people. The bot can't change its own reply mode. A few rules keep a person in charge after that:

- When someone on the team replies, they take the conversation, and a bot that sends directly gets `human_handling` and stops.
- The agent can hand a conversation to a person, with a note that says why, and Dinghy alerts the assignee.
- An owner or admin can pause every bot with one switch. Reads, notes and handoffs still work.

Your agent can also read the team's saved replies before it drafts, so its answers use your facts and your words. [Bring your own AI agent](/blog/bring-your-own-ai-agent) walks through a setup, and [live chat for AI agents](/for/ai-agents) covers what an agent can and can't do.

This isn't for everyone. If you want a bot that works the day you sign up, with no code and no model account, Intercom Fin, Tidio Lyro or Crisp's AI agent will get you there faster. Dinghy expects you to bring the agent, such as Claude Code on a laptop or a small script on a server.

## What we'd do with a team of three

Start with live chat and no bot. Answer everything yourselves for a month and save a reply each time you type the same answer twice. Those saved replies are the list of questions a bot could take.

Then connect an agent in drafts only and read what it writes for a few weeks. Count how often you send a draft unchanged. If it's most of the time for a kind of question, have the agent send those and hand off the rest, and test the handoff first. Keep a person on billing, bugs, angry customers and anyone who's about to buy.

Need words for the replies a person still writes? Our [customer service phrases](/blog/customer-service-phrases) post has rewrites that work in chat.
