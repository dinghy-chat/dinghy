---
title: Bring your own AI agent to your live chat | Dinghy
nav: Bring your own AI agent
description: Dinghy has no AI of its own and no AI fee. Your own agent connects through MCP or the API, writes drafts first, and hands chats to your team.
date: 2026-11-08
updated: 2026-11-22
order: 2
card: Your agent drafts, your team sends, the price stays flat
image: bring-your-own-ai-agent
---

# Bring your own AI agent to your live chat

Connect your own bot to Dinghy and it starts in **Drafts only**. It writes a reply, and your team can edit, send or discard it.

Dinghy Cloud is $9 a month per workspace for up to five people. We don't charge per AI reply. If your bot uses a paid model, you'll still pay that provider.

## Your agent connects through MCP or the API

Dinghy has an MCP server at `/v1/mcp` and an HTTP API. Claude Code, Cursor and other clients that support remote MCP can connect with OAuth. You approve it on Dinghy's consent page, pick a workspace and an access level, and it never sees your password. A bot on a server uses an API key instead.

![A laptop agent connects through MCP after a consent page, a server bot connects with an API key, and both reach the conversations, saved replies and internal notes in a Dinghy workspace.](/img/illustrations/bring-your-own-ai-agent-connect.webp)

With that, an agent can:

- Read conversations, the visitor's details and the pages they saw.
- Look up your team's saved replies, so it answers with your facts and your words.
- Reply, or write an internal note only your team sees.
- With Full access, install the chat on your site and check it loads. The [Claude Code guide](/guides/claude-code) shows how.

## Drafts first

A new key or connection starts in **Drafts only**. The agent's reply waits under the conversation as a suggestion, marked with the bot's name. The visitor sees nothing yet. A person clicks **Send**, **Edit** or **Discard**.

![A bot's draft waits under the conversation, out of the visitor's sight, until a person chooses to send, edit or discard it, and only an owner or admin can switch the bot to send directly.](/img/illustrations/bring-your-own-ai-agent-drafts-first.webp)

You can also ask a bot to try again. Select **Ask to change** and tell it what to fix, such as “shorter” or “in Spanish.” A bot that supports revisions replaces its own draft for you to review. Enable it for the bot’s API key in **Settings > API & webhooks**. See [Ask to change](/docs/agents#ask-to-change).

Once its drafts are good, an owner or admin can switch it to **Send directly**. The bot can't flip that itself.

## Handoff, and one switch to stop every bot

If someone asks for a refund or wants to talk to a person, have the bot hand over the chat. The bot supplies a reason and a summary. Dinghy adds them as a note and alerts the team. From then on a person handles that chat. A bot in Drafts only can still suggest replies there. A bot that sends directly stops.

If a bot misbehaves, an owner or admin pauses every bot in the workspace with one switch. Replies and drafts stop right away. Reads, notes and handoffs still work, so a paused bot can still pass a chat to people.

## A bot on a self-hosted install

On your own server, Dinghy still needs no outside account. Your bot can use a model you run locally or a model provider you choose. With a hosted model, check what customer data your bot sends to that provider.

## When to pick a tool with a hosted AI agent

If you want a vendor to run the bot for you, look at [Intercom](/compare/intercom) or [Tidio](/compare/tidio). [Chatbot vs live chat](/blog/chatbot-vs-live-chat) compares what their AI answers cost.

[Connect an agent and set its reply mode](/docs/agents).
