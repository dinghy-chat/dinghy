---
title: AHT calculator: average handle time for chat and calls
nav: AHT calculator
description: Free average handle time calculator. Add chat or talk time and wrap-up time, divide by conversations, and get your AHT, with the formula and an example.
date: 2026-11-27
updated: 2026-11-27
order: 5
card: Chat time plus wrap-up time, divided by conversations
---

# AHT calculator

Average handle time, or AHT, is how long a conversation keeps someone on your team busy, from the moment they pick it up to the last note after it. Add up the chat time and the wrap-up time, then divide by the number of conversations.

<div class="tool" data-tool="aht">
<div class="tool-fields">
<label class="tool-field"><span class="tool-label">Chat or call time</span><span class="tool-hint">Total minutes. For calls, include hold time</span><input type="number" name="chat" value="1200" min="0" step="any" inputmode="decimal"></label>
<label class="tool-field"><span class="tool-label">Wrap-up time</span><span class="tool-hint">Notes and follow-up, total, in minutes</span><input type="number" name="wrapUp" value="300" min="0" step="any" inputmode="decimal"></label>
<label class="tool-field"><span class="tool-label">Conversations</span><span class="tool-hint">Handled in the same period</span><input type="number" name="conversations" value="150" min="1" step="1" inputmode="numeric"></label>
</div>
<div class="tool-result" aria-live="polite">
<p class="tool-answer"><span class="tool-answer-label">Average handle time</span><span class="tool-answer-value" data-out="aht">10 min</span></p>
<dl class="tool-stats">
<div><dt>In minutes</dt><dd data-out="minutes">10</dd></div>
</dl>
<p class="tool-error" data-error hidden>Enter at least one conversation, with no negative times.</p>
</div>
</div>

## How AHT works

The clock starts when someone on your team picks up the conversation and stops when they've finished everything for it. Time in the queue before that doesn't count. On a phone line that's talk time, hold time and wrap-up. On live chat, it's the time the chat takes up one of the agent's chat slots, plus any work after it, such as writing a note or filing a bug.

## The AHT formula

Add the total chat or call time to the total wrap-up time, then divide by the number of conversations.

Say your team handled 150 chats last week. They spent 1,200 minutes in those chats and 300 minutes on notes and follow-ups.

1. 1,200 plus 300 is 1,500 minutes of work.
2. 1,500 divided by 150 is 10.
3. Your AHT is 10 minutes per chat.

On a phone line, add hold time to talk time before you divide.

## What a normal chat AHT looks like

AHT depends on what people ask, so there's no good number for everyone. For a reference, [LiveChat's customer service report](https://www.livechat.com/customer-service-report/), last updated in 2024, gives an average chat duration of 8 minutes 25 seconds. [Comm100's 2025 benchmark report](https://www.comm100.com/wp-content/uploads/2025/03/application/pdf/Comm100-Live-Chat-Benchmark-Report-2025.pdf) puts its 2024 average at 8 minutes 50 seconds, and 10 minutes 25 seconds for teams of 1 to 5 agents. Both count how long chats lasted, not wrap-up, so add your own wrap-up time on top.

## Common mistakes

- Counting how long a chat stayed open. A visitor who leaves the tab open for an hour isn't an hour of work. Count from when the agent picks up the chat to when they close it or move on.
- Leaving out wrap-up. If notes and follow-ups take a few minutes per chat, AHT without them makes your team look faster than it is, and your staffing plan comes out short.
- Comparing chat AHT with phone AHT. A chat agent often has two or three chats open at once, so each chat lasts longer, but the agent handles more of them per hour.
- Pushing AHT down as a goal. A short chat that doesn't solve the problem comes back as a second chat. Watch AHT next to how many questions get solved the first time.

## AHT for a small live chat team

You need AHT to plan staffing. The [staffing calculator](/tools/staffing-calculator) takes it as an input, with your chats per hour, to say how many people you need on shift. For a small team, a rough number is enough. Time a week of chats by hand and include the wrap-up. If AHT goes up, look at which questions take longest, since a saved reply or a docs page often fixes those.

## FAQ

### What is a good average handle time?

It depends on the questions you get. A password reset takes a minute and a billing dispute takes twenty. The chat lengths in the benchmarks above, 8 to 10 minutes plus wrap-up, are a fair starting point. Track your own AHT by type of question to see where time goes.

### Does AHT include waiting time?

Not the wait before pickup. That's a separate number, often called speed of answer. Once someone picks up, everything counts, including hold time on a call and the time spent reading a chat before the first reply.

### How do you calculate AHT for chat when agents handle several chats at once?

Measure each chat on its own, even when two overlap. Count from when the agent picks it up to when they move on, add its wrap-up, and divide the total by the number of chats. Each chat will look longer than on the phone, and that's fine. When you plan staff, tell the [staffing calculator](/tools/staffing-calculator) how many chats one person handles at once, and it accounts for the overlap.

### How do I lower AHT without hurting quality?

Save replies for the questions you answer every day, write a docs page for the long ones, and give your team the context, such as who the visitor is and which page they're on, before they ask for it.
