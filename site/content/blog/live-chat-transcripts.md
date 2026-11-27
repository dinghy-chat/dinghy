---
title: What a chat transcript is, and how to send, keep and delete one
nav: Chat transcripts
description: What a chat transcript is, when to email it to the visitor, how long to keep transcripts, how to export or delete them, and the GDPR basics for a small team.
date: 2026-11-27
updated: 2026-11-27
order: 50
card: Send them, keep them as long as you need, delete the rest
image: chat-transcripts
---

# Chat transcripts

A chat transcript is the written record of a live chat conversation. It holds every message from the visitor and your team, in order, with times. Most chat tools let you email it to the visitor, keep it in the inbox and export it.

![A long scroll of chat bubbles unrolls from a ship's logbook, next to a quill and a ship in a bottle](/img/illustrations/chat-transcripts.png)

The useful questions are when to send it, how long to keep it and how to get rid of it. Here's how we think about each, for a team of a few people.

## Send the transcript to the visitor

Visitors close tabs. They chat on their phone in a queue, then lose the page. If you answered their question and they never saw it, the chat was wasted. An emailed transcript fixes that. It also gives them your instructions in writing, so they don't come back to ask the same thing.

Send it when:

- You replied after they left the page.
- Your answer has steps, links or numbers they'll want later.
- You promised something, such as a refund or a fix by Friday. The email is the receipt.

Don't send it for a chat that ended with "thanks, that's all". And don't send a transcript of a chat where nobody on your team replied. That email reads as "we saw you and ignored you".

## How Dinghy sends transcripts

Dinghy emails transcripts only to visitors who gave an email, and only if your install has a mail server. Dinghy Cloud has one. A self-hosted server needs `SMTP_URL`.

![When a conversation closes, Dinghy waits 5 minutes and then emails the visitor both sides of the chat without internal notes, and reopening the conversation within those 5 minutes cancels the email.](/img/illustrations/live-chat-transcripts-close-and-send.png)

- When you close a conversation, Dinghy waits 5 minutes, then emails the visitor the chat so far, both sides. If nobody on the team replied, or the visitor unsubscribed from your emails, nothing goes out. The email has a link to continue the chat.
- If you reopen the conversation within those 5 minutes, the email is cancelled.
- After the first transcript, each one holds only the messages since the last transcript the visitor got, so they don't get the whole chat twice.
- **Email transcript** in the conversation's **…** menu sends the conversation now, not only the new messages.
- An email holds the newest messages that fit, up to 100, and says how many earlier ones are in the chat. A longer chat doesn't fit in one email.
- Internal notes never appear in a transcript.
- **Settings > Appearance** turns off the email at close.

While the conversation is still open, Dinghy can also email a visitor the replies they haven't read, unless they unsubscribed. If a self-hosted server has [replies by email](/docs/self-hosting#replies-by-email) on, the visitor can answer the email, and their answer goes back into the conversation. The [operator guide](/docs/operator-guide) covers the details.

## Keep transcripts as long as you use them

Old chats are useful. When a customer writes in again, the last conversation tells you what they tried, what you promised and how they talk. Teams that delete after 30 days lose that.

Old chats are also a liability. They hold names, emails, order numbers, and sometimes things visitors shouldn't have typed, such as a card number or a password. Every month you keep them is a month they can leak.

Pick a period you can explain by what you use the chats for, write it down and apply it. For example, "we keep chats so we can see a customer's past problems, and delete them a year after their last contact." A shop with returns might need the chat until the return window and any dispute have passed. A company with a legal duty to keep records has a different answer, so ask someone who knows your case.

Then actually delete. A retention policy that nobody runs is just a sentence in your privacy notice.

## What Dinghy keeps, and for how long

Here's what Dinghy does today, from its docs:

![Four bars compare how long Dinghy keeps data: message text until someone deletes it, images and files on Dinghy Cloud for 12 months, pages seen after a chat for 90 days at most, and site analytics totals for 182 days.](/img/illustrations/live-chat-transcripts-retention.png)

| Data | How long |
|---|---|
| Message text | Until someone on your team deletes it |
| Images and files on Dinghy Cloud | Deleted 12 months after they were sent. The text stays, and the chat shows "Image removed after 12 months" or "File removed after 12 months" in their place |
| Pages a visitor saw after they chatted | The newest 100, for 90 days at most |
| Site analytics | Hourly totals, kept 182 days |
| A Dinghy Cloud workspace after the subscription ends | Read-only for 90 days, then deleted |

There's no automatic delete for old conversations. If your policy says two years, someone on the team deletes the older ones.

## Export transcripts

You need an export when you leave a tool, when a customer asks for their data, or when you want the chats somewhere else.

In Dinghy:

- An owner selects **Download an export** in **Settings > Workspace**. The file holds the workspace's conversations, contacts, outbound messages, team, settings and images, and it imports into another Dinghy server. [Moving a workspace](/docs/self-hosting#moving-a-workspace) has the steps.
- **Contacts** has **Export CSV**, which downloads the list of people who chatted.
- Through the [API and MCP server](/docs/agents), `get_conversation` with `format: "markdown"` gives a short transcript of one conversation, for a script or an agent.

Before you pick any chat tool, check what its export holds. Some only export a contact list. If the conversations don't come out, you're locked in.

## Delete transcripts

In Dinghy, owners and admins can delete:

![On a self-hosted server with the built-in backup, a deleted chat stays in the newest 7 nightly backups and is gone from them about a week later, because each night drops the oldest copy.](/img/illustrations/live-chat-transcripts-backups.png)

- One conversation, with its images and files, from the conversation's **…** menu.
- Several at once, from the Inbox, with **Delete** in the **More actions** menu.
- A contact, with all their conversations, messages and images, from **Delete contact** on their page.

An owner can also delete the whole workspace from **Settings > Workspace**, and the worker deletes its data within a few minutes. A self-hosted server always keeps at least one workspace.

Deleted chats can live on in your backups. If you self-host with the built-in backup, the server keeps the newest 7 nightly copies, so a deleted chat is gone from them about a week later. A backup bucket, or any backup you run yourself, keeps copies for as long as its own rule says. Check that rule, or your retention period is whatever the bucket says.

## GDPR basics for chat transcripts

A transcript usually holds personal data, such as a name, an email or an order number. Under Article 3, the GDPR can apply if your business is in the EU, offers goods or services to people there, or monitors what they do there. This isn't legal advice, but a few articles of the [official GDPR text](https://eur-lex.europa.eu/eli/reg/2016/679/oj) cover most of what a small team runs into:

- **Article 5(1)(e)**, storage limitation. Personal data is kept "for no longer than is necessary for the purposes" you collected it for. That's the reason to have a retention period at all.
- **Article 15**, right of access. A person can ask what you hold about them, and you provide "a copy of the personal data undergoing processing". For chat, that means their messages and anything else you keep about them, such as contact details.
- **Article 17**, right to erasure. A person can ask you to delete their data. You must when one of the article's grounds applies, such as you no longer needing it, unless an exception lets you keep it, such as a legal duty to keep a record.
- **Article 20**, data portability. A person can ask for the data they gave you in a machine-readable format they can take elsewhere. This applies when you process the data by automated means, which a chat tool does, and rely on their consent or a contract. Check which legal basis you use for support chats.
- **Article 12(3)**, the deadline. You answer these requests "without undue delay and in any event within one month". For complex or numerous requests you can take two more months, but you have to tell the person, and why, within the first month.

In practice, for one visitor's request:

1. Make sure the request comes from that person. A name or an email typed in a chat isn't proof, since anyone can type someone else's. If they have an account with you, ask them to send the request from the address on that account.
2. Search for them in **Contacts** by name or email. Check that each chat you find is really theirs.
3. For an access request, don't use **Email transcript**. It sends right away, holds at most 100 messages, leaves out notes and only links to files. Pull their conversations, contact details and files from the workspace export or the [API](/docs/api) instead, and read every page if the API splits a chat. Read the copy before you send it. Internal notes are in the API and the export. Keep what a note says about the person, and black out anything about other people.
4. For an erasure request that covers everything, use **Delete contact**. It deletes the person with all their conversations, messages and images.
5. Note the date you answered. If you self-host, check when your backups expire before you give the person a date.

Also tell visitors, in your privacy notice, that chats are stored, for how long, and who can read them. If you connect an AI agent, say that too, because the messages go wherever that agent sends them. Our [privacy page](/for/privacy) lists everything Dinghy's widget and server store.

## Don't let visitors paste secrets

The simplest privacy fix costs nothing. Never ask for a password, a full card number or an ID document in chat. If a visitor pastes a password anyway, ask them to change it right away. For a card number, tell them to call their bank. Then have an owner or admin delete that message from the chat, and don't repeat it in your reply. A transcript that already went out by email still has it.
