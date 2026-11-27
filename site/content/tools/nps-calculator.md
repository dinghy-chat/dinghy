---
title: NPS calculator: work out your Net Promoter Score
nav: NPS calculator
description: Free NPS calculator. Enter your promoters, passives and detractors to get your Net Promoter Score from -100 to 100, with the formula and a worked example.
date: 2026-11-27
updated: 2026-11-27
order: 1
card: Promoters, passives and detractors in, a score from -100 to 100 out
image: nps-calculator
---

# NPS calculator

Type how many people answered 9 or 10, 7 or 8, and 0 to 6 to "How likely are you to recommend us to a friend?". Your Net Promoter Score updates as you type.

<div class="tool">
<div class="tool-pane" data-tool="nps">
<div class="tool-inputs">
<p class="tool-kicker">Your survey answers</p>
<div class="tool-field"><label class="tool-label" for="nps-promoters" data-swatch="good"><b>Promoters</b><span>Answered 9 or 10</span></label><div class="tool-input" data-stepper><input id="nps-promoters" type="number" name="promoters" value="60" min="0" step="1" inputmode="numeric"></div></div>
<div class="tool-field"><label class="tool-label" for="nps-passives" data-swatch="fair"><b>Passives</b><span>Answered 7 or 8</span></label><div class="tool-input" data-stepper><input id="nps-passives" type="number" name="passives" value="25" min="0" step="1" inputmode="numeric"></div></div>
<div class="tool-field"><label class="tool-label" for="nps-detractors" data-swatch="poor"><b>Detractors</b><span>Answered 0 to 6</span></label><div class="tool-input" data-stepper><input id="nps-detractors" type="number" name="detractors" value="15" min="0" step="1" inputmode="numeric"></div></div>
<p class="tool-formula"><span class="tool-kicker">The math</span><span class="tool-sum"><span data-out="promoters">60%</span> promoters − <span data-out="detractors">15%</span> detractors = <b data-out="score">+45</b></span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Your NPS</p>
<p class="tool-big" data-out="score">+45</p>
<p class="tool-verdict" data-verdict data-tone="good">Above the B2B SaaS average of 41.</p>
<p class="tool-error" data-error hidden>Enter at least one response, with no negative counts.</p>
</div>
<div class="tool-visual" data-visual></div>
<dl class="tool-stats is-three">
<div><dt data-swatch="good">Promoters</dt><dd data-out="promoters">60%</dd></div>
<div><dt data-swatch="fair">Passives</dt><dd data-out="passives">25%</dd></div>
<div><dt data-swatch="poor">Detractors</dt><dd data-out="detractors">15%</dd></div>
</dl>
<p class="tool-note"><span data-out="total">100</span> responses. One detractor who turns promoter adds <span data-out="swing">2 points</span>. The marks show Retently's 2026 averages: 41 for B2B SaaS and 61 for ecommerce.</p>
<div class="tool-actions"><button type="button" class="tool-button" data-share="result">Copy result</button><button type="button" class="tool-button is-quiet" data-share="link">Copy link</button><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>

## How NPS works

You ask one question, "On a scale of 0 to 10, how likely are you to recommend us to a friend or colleague?" Then you sort the answers into three groups, as [Bain & Company, which created NPS, defines them](https://www.netpromotersystem.com/about/measuring-your-net-promoter-score/).

| Answer | Group |
|---|---|
| 9 or 10 | Promoters |
| 7 or 8 | Passives |
| 0 to 6 | Detractors |

Passives count toward the total but not toward the score. That's why moving someone from 6 to 7 helps your score, and moving someone from 8 to 9 helps it too.

![A lighthouse beam shows a score dial over small sailboats at sea](/img/illustrations/nps-calculator.png)

## The NPS formula

NPS is the percent of promoters minus the percent of detractors. The score runs from -100, where everyone is a detractor, to 100, where everyone is a promoter. Most people round it to a whole number. This calculator shows up to one decimal place. It's not a percent, so write 45, not 45%.

Say 200 customers answer. 110 give a 9 or 10, 50 give a 7 or 8, and 40 give 0 to 6.

1. Promoters are 110 of 200, which is 55%.
2. Detractors are 40 of 200, which is 20%.
3. 55 minus 20 is 35. Your NPS is 35.

## What a good NPS looks like

[Call Centre Helper](https://www.callcentrehelper.com/industry-standards-metrics-125584.htm) calls any score above zero good, since it means more promoters than detractors. Scores vary a lot by industry. [Retently's 2026 benchmarks](https://www.retently.com/blog/good-net-promoter-score/) put the average for B2B software and SaaS at 41 and for ecommerce at 61. Compare yourself with your own last quarter first. A rising score matters more than beating someone else's average.

## Common mistakes

- Treating NPS as a percent. A score of 30 means promoters outnumber detractors by 30 points. It doesn't mean 30% of people are happy.
- Mixing survey audiences. An NPS survey sent after a support chat only reaches people who needed help, so its score usually differs from one sent to all customers. Track the two separately.
- Reading a score from a handful of answers. With 20 responses, one detractor who becomes a promoter moves the score by 10 points.
- Asking only happy customers, such as people who just left a good review. The score then says more about who you asked.
- Dropping passives from the total. They don't count as promoters or detractors, but they do count in the number you divide by.

## NPS for a small live chat team

A team of two or three people usually gets few survey answers, so a monthly NPS swings for reasons that have nothing to do with the work. Read the comments people leave with the score, and keep a running count over a quarter instead of a month. If someone mentions a slow reply, check how long they waited. [Dinghy's analytics](/docs/operator-guide#see-how-support-is-going) shows first reply times, which you can watch next to your score. Dinghy doesn't send NPS surveys itself.

## FAQ

### What is a good NPS score?

Above zero means you have more promoters than detractors, which [Call Centre Helper](https://www.callcentrehelper.com/industry-standards-metrics-125584.htm) calls good. For a sense of industry averages, [Retently's 2026 benchmarks](https://www.retently.com/blog/good-net-promoter-score/) give 41 for B2B software and SaaS and 61 for ecommerce.

### How do you calculate NPS in Excel or Google Sheets?

Put each answer from 0 to 10 in column A, say A2 to A201. Then use `=(COUNTIF(A2:A201,">=9")-COUNTIF(A2:A201,"<=6"))/COUNT(A2:A201)*100`. The first COUNTIF counts promoters, the second counts detractors, and COUNT gives the total.

### Can NPS be negative?

Yes. If you have more detractors than promoters, the score is below zero. The lowest score is -100.

### How many responses do I need?

There's no fixed number, but small samples swing a lot. With 50 answers, one person going from detractor to promoter moves the score by 4 points. If a swing that size would change what you do, wait for more answers.
