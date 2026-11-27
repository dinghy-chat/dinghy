---
title: Erlang C calculator for live chat and support staffing
nav: Erlang C staffing calculator
description: Free Erlang C calculator for live chat and call centers. Enter chats per hour, handle time and your answer target to see how many agents you need on shift.
date: 2026-11-27
updated: 2026-11-27
order: 3
card: How many people you need on shift to answer chats in time
image: staffing-calculator
---

# Erlang C calculator for live chat staffing

Enter how many chats you get in your busiest hour, how long one takes and how fast you want someone to pick each one up. The calculator uses the Erlang C formula to find the fewest people on shift who hit that target, then adds shrinkage for breaks and time off.

<div class="tool">
<div class="tool-pane" data-tool="staffing">
<div class="tool-inputs">
<p class="tool-kicker">Your busiest hour</p>
<div class="tool-field"><label class="tool-label" for="staff-per-hour"><b>Chats per hour</b><span>New chats in that hour</span></label><div class="tool-input"><input id="staff-per-hour" type="number" name="perHour" value="20" min="0" step="any" inputmode="decimal"><span class="tool-unit">chats/h</span></div><input class="tool-range" type="range" min="1" max="120" step="1" data-for="perHour" tabindex="-1" aria-hidden="true"></div>
<div class="tool-field"><label class="tool-label" for="staff-handle"><b>Average handle time</b><span>Per chat, with wrap-up</span></label><div class="tool-input"><input id="staff-handle" type="number" name="handleMinutes" value="10" min="0" step="any" inputmode="decimal"><span class="tool-unit">min</span></div><input class="tool-range" type="range" min="1" max="45" step="1" data-for="handleMinutes" tabindex="-1" aria-hidden="true"></div>
<div class="tool-field"><label class="tool-label" for="staff-concurrency"><b>Chats at once</b><span>Per person. Use 1 for phone calls</span></label><div class="tool-input" data-stepper><input id="staff-concurrency" type="number" name="concurrency" value="2" min="1" step="1" inputmode="numeric"></div></div>
<p class="tool-kicker">Your target</p>
<div class="tool-field is-row"><label class="tool-label" for="staff-seconds"><b>Pick up within</b><span>Until an agent is free</span></label><div class="tool-input"><input id="staff-seconds" type="number" name="targetSeconds" value="60" min="0" step="any" inputmode="decimal"><span class="tool-unit">s</span></div></div>
<div class="tool-field is-row"><label class="tool-label" for="staff-percent"><b>Service level</b><span>Chats picked up in time</span></label><div class="tool-input"><input id="staff-percent" type="number" name="targetPercent" value="80" min="0" max="100" step="any" inputmode="decimal"><span class="tool-unit">%</span></div></div>
<div class="tool-field is-row"><label class="tool-label" for="staff-shrinkage"><b>Shrinkage</b><span>Paid time not on chat</span></label><div class="tool-input"><input id="staff-shrinkage" type="number" name="shrinkagePercent" value="30" min="0" max="100" step="any" inputmode="decimal"><span class="tool-unit">%</span></div></div>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">People on shift</p>
<p class="tool-big" data-out="agents">3</p>
<p class="tool-verdict" data-verdict data-tone="info">Schedule 5 people so 3 are on chat after breaks and time off.</p>
<p class="tool-error" data-error hidden>Enter chats and a handle time above zero, at least 1 chat at once, a target between 0% and 100%, and shrinkage under 100%.</p>
</div>
<div class="tool-visual" data-visual></div>
<dl class="tool-stats is-three">
<div><dt>Average wait</dt><dd data-out="wait">33 s</dd></div>
<div><dt>Occupancy</dt><dd data-out="occupancy">56%</dd></div>
<div><dt>Erlangs</dt><dd data-out="traffic">3.33</dd></div>
</dl>
<div class="tool-actions"><button type="button" class="tool-button" data-share="result">Copy result</button><button type="button" class="tool-button is-quiet" data-share="link">Copy link</button><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>

## How Erlang C works

Erlang C is a queueing formula from the early 1900s, named after A. K. Erlang, who worked out how many lines a telephone exchange needed. It takes the work arriving in an hour and a number of agents, and gives the chance that a new chat has to wait for a free agent. From that, it gives the share picked up within your target time and the average wait. That wait is time in the queue. The first reply comes a little after, once the agent has read the question and typed an answer.

The work arriving is called traffic, measured in erlangs. One erlang is enough work to keep one chat slot busy for a full hour. Multiply chats per hour by the handle time in hours to get traffic. If you get 20 chats an hour and each takes 10 minutes, that's 20 times 10 divided by 60, or 3.33 erlangs. With fewer than 4 chat slots, the queue grows forever. At 2 chats at once, that's 2 people. Erlang C tells you how many you need to hit your wait target, which is 3 here.

![Small crewed sailboats leave a harbor to meet chat bubbles floating on the water](/img/illustrations/staffing-calculator.webp)

## The Erlang C formula with a worked example

The calculator tries one agent count after another until the service level reaches your target. For each count:

1. Work out the traffic in erlangs, as above.
2. Work out the chance a chat waits with the Erlang C formula. [Wikipedia's Erlang page](https://en.wikipedia.org/wiki/Erlang_(unit)#Erlang_C_formula) has the full formula.
3. Subtract the traffic from the number of chat slots to get the spare capacity. With 3 people at 2 chats each and 3.33 erlangs, that's 6 minus 3.33, or 2.67.
4. The service level is `1 - wait chance × e^(-spare capacity × target time / handle time)`, with both times in the same unit.
5. The average wait is `wait chance × handle time / spare capacity`. It averages over every chat, including the ones picked up right away.

Here's [Call Centre Helper's worked example](https://www.callcentrehelper.com/erlang-c-formula-example-121281.htm), which this calculator matches. A phone team gets 100 calls in 30 minutes, each takes 3 minutes, and it wants 80% answered within 20 seconds, with 30% shrinkage.

| Agents | Chance a call waits | Answered in 20 seconds |
|---|---|---|
| 11 | 68.2% | 39.0% |
| 12 | 44.9% | 64.0% |
| 13 | 28.5% | 79.6% |
| 14 | 17.4% | 88.8% |

So the team needs 14 people on the phones, with an average wait of 7.8 seconds. With 30% shrinkage, 14 divided by 0.7 is 20 people on the schedule. Put 200 calls an hour, 3 minutes, 1 at once, 20 seconds, 80% and 30% in the calculator to check.

## Chat is not phone

On the phone, one person takes one call. On chat, one person can keep two or three chats going, since visitors take time to type. [Comm100 suggests](https://www.comm100.com/blog/live-chat-best-practices.html) starting new agents at two chats at once and experienced ones at three to four. This calculator treats each person as that many chat slots. So 3 people who each handle 2 chats count as 6 slots.

The catch is that each chat takes longer when someone handles several at once. If your handle time of 10 minutes comes from people who handle 2 chats at a time, enter 10 and 2. Don't enter the 6 minutes a chat might take on its own. Set chats at once too high and people end up juggling, replies slow down and visitors leave.

## What target to pick

"The traditional service level in the contact centre is to answer 80% of calls in 20 seconds", says [Call Centre Helper](https://www.callcentrehelper.com/industry-standards-metrics-125584.htm), which lists the same 80% in 20 seconds for chat. That's a big team's target. A small team can pick any target its visitors accept, such as 80% within a minute. Tighter targets cost more people, and the calculator shows how many.

## Common mistakes

- Using a daily average. Chats bunch up at certain hours. Plan for your busiest hour, or plan hour by hour.
- Forgetting shrinkage. Breaks, meetings, training, sick days and holidays take people off chat. The number on shift is not the number you need to employ.
- Leaving out wrap-up from handle time. If a chat needs a note or a follow-up after it ends, that time is still busy time.
- Aiming for 100% occupancy. A team that is always busy has no slack for a spike, so waits jump. In Erlang C, one person fewer can cut the service level a lot.
- Trusting Erlang C for very small teams too much. It assumes nobody gives up waiting and that chats arrive at random. With two or three people, treat the answer as a rough guide.

## Staffing a small live chat team

Most small teams don't need a workforce tool. Take the defaults above: 20 chats in your busiest hour, 10 minutes each, 2 at a time. The model says 3 people on shift pick up about 89% of chats within a minute, and with 30% shrinkage you'd schedule 5 people for that hour. With a team this small, treat that as a starting point and check it against what really happens. Dinghy's [analytics](/docs/operator-guide#see-how-support-is-going) shows your busiest hours and how long visitors waited for a first reply.

## FAQ

### What is the Erlang C formula used for?

It estimates how many agents you need to answer a queue of calls or chats within a target time. Call centers have used it for decades. For live chat, counting each agent's chat slots gives a rough estimate. Check it against your real waits, especially on a small team.

### What's the difference between Erlang B and Erlang C?

Erlang B is for systems where a caller who finds every line busy is turned away, such as phone trunks. Erlang C is for systems where they wait in a queue, which is how support works.

### How many chats can one agent handle at once?

[Comm100 suggests](https://www.comm100.com/blog/live-chat-best-practices.html) two at once for new agents and three to four for experienced ones. It depends on how complex the questions are. Billing problems need more attention than "what are your opening hours?".

### What is shrinkage in staffing?

Shrinkage is the share of paid time when people aren't available to answer, such as breaks, meetings, training, sick days and holidays. If shrinkage is 30%, you need 10 people on the schedule to have 7 on chat.

### What does 80/20 mean in a call center?

80% of calls answered within 20 seconds. [Call Centre Helper](https://www.callcentrehelper.com/industry-standards-metrics-125584.htm) calls it the traditional contact center service level. It's a convention, not a rule, so pick a target your own visitors accept.
