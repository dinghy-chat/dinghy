---
title: Bring your own AI agent to your live chat | Dinghy
nav: Bring your own AI agent
description: Dinghy has no AI of its own and no AI fee. Your own agent connects through MCP or the API, writes drafts first, and hands chats to your team.
date: 2026-11-08
updated: 2026-11-14
order: 2
card: Your agent drafts, your team sends, the price stays flat
---

# Bring your own AI agent to your live chat

Intercom bills per Fin outcome. Tidio sells Lyro conversations. tawk.to has AI Assist. Crisp puts its AI agent in its Plus plan.

Dinghy has no AI of its own, and I don't sell any. But if you want a bot to answer chats, your own agent can do it. And by default a person still approves what it says.

## A person answers by default

If you're a team of one to five, your support is probably your best feature. A customer writes, and the person who built the thing answers.

A bot sits between your customer and you. Some customers don't mind. Some write to you exactly because they want a person. So in Dinghy, every answer comes from a person unless you connect a bot. And even then, a person approves its replies until you change that.

## Per-answer AI pricing changes your bill

An AI answer costs money every time, so the tools pass that on, per resolution or per bundle of conversations. But it means your bill depends on how busy your month was.

Dinghy charges no AI fee. Dinghy Cloud is one flat price, $7 a month for up to 5 people. If you connect a bot, you pay your own model provider for what it uses, and nothing more to us.

## Your agent connects through MCP or the API

Dinghy has an MCP server at `/v1/mcp` and an HTTP API. Claude Code, Cursor or any MCP client connects with OAuth in the browser. You approve it on Dinghy's consent page, pick a workspace and an access level, and it never sees your password. A bot on a server uses an API key instead.

With that, an agent can:

- Read conversations, the visitor's details and the pages they saw.
- Look up your team's saved replies, so it answers with your facts and your words.
- Reply, or write an internal note only your team sees.
- With Full access, install the chat on your site and check it loads. The [Claude Code guide](/guides/claude-code) shows how.

## Drafts first

A new key or connection starts in **Drafts only**. The agent's reply waits under the conversation as a suggestion, marked with the bot's name. The visitor sees nothing yet. A person clicks **Send**, **Edit** or **Discard**.

Once its drafts are good, an owner or admin can switch it to **Send directly**. The bot can't flip that itself.

## Handoff, and one switch to stop every bot

Some questions the agent can't or shouldn't answer, like money, an account or a complaint. Then it hands the conversation to a person. It gives a reason and a summary, Dinghy adds them as a note, and the team gets an alert. From then on a person handles that chat. A bot in Drafts only can still suggest replies there. A bot that sends directly stops.

If a bot misbehaves, an owner or admin pauses every bot in the workspace with one switch. Replies and drafts stop right away. Reads, notes and handoffs still work, so a paused bot can still pass a chat to people.

## A bot on a self-hosted install

On your own server, Dinghy still needs no outside account. It needs a model provider you pick, an API key with them, and a bill from them. It also means your customer messages go to that provider, so pick one whose privacy terms you're OK with.

## When to pick a tool with a hosted AI agent

Some teams want a ready-made AI agent, trained on their help center, with no setup. If you get hundreds of the same three questions a day, or need answers at 3 a.m. with nobody around to approve them, that saves real hours.

If that's you, look at [Intercom](/compare/intercom) or [Tidio](/compare/tidio).

You can write your own bot or have Claude Code answer while you watch. [Use Dinghy with AI agents](/docs/agents) has every tool and the safety rules.
