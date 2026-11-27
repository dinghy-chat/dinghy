---
title: CSAT calculator: how to calculate your CSAT score
nav: CSAT calculator
description: Free CSAT calculator. Enter satisfied responses and total responses to get your customer satisfaction score, with the CSAT formula and a worked example.
date: 2026-11-27
updated: 2026-11-27
order: 2
card: Satisfied responses over total responses, as a percent
image: csat-calculator
---

# CSAT calculator

Your CSAT score is the share of people who said they were satisfied. On a 1 to 5 scale, that's everyone who picked 4 or 5, as [Qualtrics explains](https://www.qualtrics.com/experience-management/customer/what-is-csat/). Enter your counts and the score updates as you type.

<div class="tool">
<div class="tool-pane" data-tool="csat">
<div class="tool-inputs">
<p class="tool-kicker">Your ratings</p>
<div class="tool-field"><label class="tool-label" for="csat-satisfied"><b>Satisfied responses</b><span>Rated 4 or 5 out of 5</span></label><div class="tool-input" data-stepper><input id="csat-satisfied" type="number" name="satisfied" value="170" min="0" step="1" inputmode="numeric"></div></div>
<div class="tool-field"><label class="tool-label" for="csat-total"><b>Total responses</b><span>Every rating you got</span></label><div class="tool-input" data-stepper><input id="csat-total" type="number" name="total" value="200" min="1" step="1" inputmode="numeric"></div></div>
<p class="tool-formula"><span class="tool-kicker">The math</span><span class="tool-sum"><span data-out="satisfied">170</span> ÷ <span data-out="total">200</span> × 100 = <b data-out="score">85%</b></span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Your CSAT</p>
<p class="tool-big" data-out="score">85%</p>
<p class="tool-verdict" data-verdict data-tone="good">Above the 79.9% live chat average in Comm100's report.</p>
<p class="tool-error" data-error hidden>Enter at least one response, and no more satisfied responses than total responses.</p>
</div>
<div class="tool-visual" data-visual></div>
<dl class="tool-stats">
<div><dt>Not satisfied</dt><dd data-out="unhappy">30</dd></div>
<div><dt>One rating moves it</dt><dd data-out="swing">0.5 points</dd></div>
</dl>
<div class="tool-actions"><button type="button" class="tool-button" data-share="result">Copy result</button><button type="button" class="tool-button is-quiet" data-share="link">Copy link</button><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>

## How CSAT works

CSAT stands for customer satisfaction score. After a chat, a ticket or a purchase, you ask one question, such as "How satisfied were you with the help you got?", with answers from 1, very unsatisfied, to 5, very satisfied. Some teams use a thumbs up and down, or a smiley scale. The math is the same. You count the good answers.

## The CSAT formula

CSAT is the number of satisfied responses divided by the number of responses, times 100.

Say 240 people rate their chat this month. 150 pick 5, 54 pick 4, and 36 pick 1, 2 or 3.

1. Satisfied responses are 150 plus 54, which is 204.
2. 204 divided by 240 is 0.85.
3. Times 100, your CSAT is 85%.

Count only the people who answered. Someone who closed the chat without rating doesn't go in the total.

## What a good CSAT looks like

[Comm100's 2025 live chat benchmark report](https://www.comm100.com/wp-content/uploads/2025/03/application/pdf/Comm100-Live-Chat-Benchmark-Report-2025.pdf) put the average CSAT for live chat at 79.9% in 2024, from chats on its own platform. It comes from one vendor's customers, and teams don't all count the same ratings as satisfied. Your own trend over a few months tells you more.

## Common mistakes

- Averaging the ratings instead. An average of 4.2 out of 5 and a CSAT of 85% are different numbers. Pick one and stick with it, so this month compares with last month.
- Counting 3 as satisfied. A 3 is neutral. If you count it, your score goes up and stops meaning much.
- Mixing surveys. A rating after a support chat measures the chat. A rating after delivery measures the product and the courier.
- Trusting a small month. With 30 ratings, one unhappy person moves the score by more than 3 points.
- Changing when you ask. A survey right after the chat and one a week later reach different people. If you switch, compare response rates before you compare scores.

## CSAT for a small live chat team

On live chat, the moment to ask is right when the chat ends, while the visitor still has the window open. For a small team, the score is less useful than the comments next to the low ratings, since they say what to fix. When a comment mentions the wait, look up how long that visitor actually waited. Dinghy doesn't have a built-in rating survey. Its [analytics](/docs/operator-guide#see-how-support-is-going) shows first reply times, and you can run a rating survey through your own tool and the [API](/docs/api).

## FAQ

### What is a good CSAT score?

For live chat, [Comm100's 2025 benchmark report](https://www.comm100.com/wp-content/uploads/2025/03/application/pdf/Comm100-Live-Chat-Benchmark-Report-2025.pdf) found an average of 79.9% in 2024 across chats on its platform. Compare yourself with your own past months first. If you compare with another team, check that it counts the same ratings as satisfied.

### How do you calculate CSAT in Excel or Google Sheets?

Put each rating from 1 to 5 in column A, say A2 to A241. Then use `=COUNTIF(A2:A241,">=4")/COUNT(A2:A241)` and format the cell as a percent.

### What's the difference between CSAT and NPS?

CSAT asks how satisfied someone was with one specific thing, such as a chat. [NPS](/tools/nps-calculator) asks how likely they are to recommend you, and people answer that with everything they think of you in mind. If you want to know how the chat went, ask about the chat.

### Should I use a 1 to 5 or a 1 to 10 scale?

A 1 to 5 scale is the common one for CSAT, and it's quick to answer. On a 1 to 10 scale you have to decide where satisfied starts, so write that down and keep it.
