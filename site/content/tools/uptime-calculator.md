---
title: Uptime calculator: SLA downtime per day, month and year
nav: Uptime and SLA calculator
description: Free uptime and SLA calculator. Turn 99.9% into allowed downtime per day, week, month and year, or turn minutes of downtime back into an uptime percent.
date: 2026-11-27
updated: 2026-11-27
order: 4
card: 99.9% is about 43 minutes a month. Turn any SLA into downtime and back
image: uptime-calculator
---

# Uptime and SLA calculator

99.9% uptime allows about 1 minute 26 seconds of downtime a day, 43 minutes 50 seconds a month and 8 hours 46 minutes a year. Type any uptime percent below to see its downtime, or switch to downtime and enter an outage to see the percent it leaves you with.

<div class="tool">
<div class="tool-switch">
<fieldset class="tool-modes"><legend class="visually-hidden">What to work out</legend><div class="tool-segments"><label><input type="radio" name="mode" value="uptime" checked>Find downtime</label><label><input type="radio" name="mode" value="downtime">Find uptime</label></div></fieldset>
<div class="tool-pane" data-tool="uptime">
<div class="tool-inputs">
<div class="tool-field"><label class="tool-label" for="uptime-percent"><b>Uptime</b><span>Such as 99.9 or 99.95</span></label><div class="tool-input"><input id="uptime-percent" type="number" name="uptime" value="99.9" min="0" max="100" step="any" inputmode="decimal"><span class="tool-unit">%</span></div></div>
<div class="tool-chips" role="group" aria-label="Common SLAs"><button type="button" class="tool-chip" data-preset="uptime" value="99">99%</button><button type="button" class="tool-chip" data-preset="uptime" value="99.5">99.5%</button><button type="button" class="tool-chip" data-preset="uptime" value="99.9">99.9%</button><button type="button" class="tool-chip" data-preset="uptime" value="99.95">99.95%</button><button type="button" class="tool-chip" data-preset="uptime" value="99.99">99.99%</button><button type="button" class="tool-chip" data-preset="uptime" value="99.999">99.999%</button></div>
<p class="tool-formula"><span class="tool-kicker">The math</span><span class="tool-sum"><span data-out="downShare">0.1%</span> of a 30.44 day month = <b data-out="monthText">43 min 50 s</b></span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Allowed downtime a month</p>
<p class="tool-big" data-out="month">43<small>min</small>50<small>s</small></p>
<p class="tool-verdict" data-verdict data-tone="info">What Google promise for one Compute Engine instance.</p>
<p class="tool-error" data-error hidden>Enter a percent from 0 to 100.</p>
</div>
<div class="tool-visual" data-visual></div>
<div class="tool-actions"><button type="button" class="tool-button" data-share="result">Copy result</button><button type="button" class="tool-button is-quiet" data-share="link">Copy link</button><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
<div class="tool-pane" data-tool="downtime" hidden>
<div class="tool-inputs">
<div class="tool-field" role="group" aria-labelledby="down-label"><p class="tool-label" id="down-label"><b>Downtime</b><span>Hours, minutes and seconds add up</span></p><div class="tool-trio"><div class="tool-input"><input id="down-hours" type="number" name="hours" value="0" min="0" step="any" inputmode="decimal" aria-label="Hours down"><span class="tool-unit">h</span></div><div class="tool-input"><input id="down-minutes" type="number" name="minutes" value="45" min="0" step="any" inputmode="decimal" aria-label="Minutes down"><span class="tool-unit">min</span></div><div class="tool-input"><input id="down-seconds" type="number" name="seconds" value="0" min="0" step="any" inputmode="decimal" aria-label="Seconds down"><span class="tool-unit">s</span></div></div></div>
<fieldset class="tool-field"><legend class="tool-label"><b>Period</b><span>Month and year are averages</span></legend><div class="tool-segments"><label><input type="radio" name="period" value="day">Day</label><label><input type="radio" name="period" value="week">Week</label><label><input type="radio" name="period" value="month" checked>Month</label><label><input type="radio" name="period" value="year">Year</label></div></fieldset>
<p class="tool-formula"><span class="tool-kicker">The math</span><span class="tool-sum">(<span data-out="periodSeconds">2,629,800</span> − <span data-out="downSeconds">2,700</span> s) ÷ <span data-out="periodSeconds">2,629,800</span> s = <b data-out="uptime">99.8973%</b></span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Uptime for the <span data-out="period">month</span></p>
<p class="tool-big" data-out="uptime">99.8973%</p>
<p class="tool-verdict" data-verdict data-tone="fair">Meets a 99.5% SLA. Misses 99.9% by 1 min 10 s.</p>
<p class="tool-error" data-error hidden>Enter a downtime that fits in the period, with no negative values.</p>
</div>
<div class="tool-visual" data-visual></div>
<div class="tool-actions"><button type="button" class="tool-button" data-share="result">Copy result</button><button type="button" class="tool-button is-quiet" data-share="link">Copy link</button><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>
</div>

## How uptime works

Uptime is the share of time a service was up. An SLA, or service level agreement, is a promise of a minimum uptime over a period, usually a calendar month, often with a credit when the provider misses it. Each extra 9 cuts the allowed downtime by ten.

| Uptime | Per month | Per year |
|---|---|---|
| 99% | 7 h 18 min 18 s | 3 d 15 h 39 min 36 s |
| 99.5% | 3 h 39 min 9 s | 1 d 19 h 49 min 48 s |
| 99.9% | 43 min 50 s | 8 h 45 min 58 s |
| 99.95% | 21 min 55 s | 4 h 22 min 59 s |
| 99.99% | 4 min 23 s | 52 min 36 s |
| 99.999% | 26 s | 5 min 16 s |

This page counts a year as 365.25 days and a month as a twelfth of that, 30.44 days. Real months differ. At 99.9%, February allows about 40 minutes and a 31-day month about 45. To check an SLA for one calendar month, use its real length and the provider's own rules for what counts as downtime.

## The uptime formula

Turn the uptime percent into a fraction, take it away from 1, and multiply by the length of the period.

For 99.9% in a 30.44-day month:

1. 1 minus 99.9% is 0.1%, or 0.001.
2. A twelfth of a 365.25-day year is 2,629,800 seconds.
3. 2,629,800 times 0.001 is 2,629.8 seconds, which is 43 minutes 50 seconds.

The reverse is uptime equals the period minus the downtime, divided by the period. For a 45-minute outage in that month, subtract 2,700 seconds from 2,629,800 and divide by 2,629,800. That gives 99.8973%. So it misses a 99.9% SLA by about a minute.

## What SLAs the big clouds promise

As a reference, here's what two large hosts promise per month, checked November 27, 2026.

| Service | Monthly uptime | Credit when missed |
|---|---|---|
| [AWS EC2](https://aws.amazon.com/compute/sla/), one instance | 99.5% | 10% of the bill below 99.5%, more below 99% |
| [AWS EC2](https://aws.amazon.com/compute/sla/), instances in two or more zones of a region | 99.99% | 10% of the bill below 99.99%, more below 99% |
| [Google Compute Engine](https://cloud.google.com/compute/sla), one instance, most machine types, Premium Tier network | 99.9% | 10% of the bill below 99.9%, more below 95% |
| [Google Compute Engine](https://cloud.google.com/compute/sla), several zones, Premium Tier network, outside Stockholm | 99.99% | 10% of the bill below 99.99%, more below 99% |

One server gets a lower promise than several, and each number comes with conditions, so read the page before you plan around it. To promise 99.99% to your own customers, you need to run in more than one place.

## Common mistakes

- Forgetting that parts depend on each other. If your app needs a server with 99.9% and a database with 99.9%, both have to be up. If their outages never overlap, add the downtime. Each is down 0.1% of the time, so the app is up 99.8%, and that's the worst case. When they go down together, the shared time counts once.
- Forgetting what the SLA counts. Many exclude planned maintenance, and some count only outages longer than a few minutes. Read the definition of downtime before you compare two numbers.
- Promising your customers the same uptime as your host. Your deploys, your code and your DNS go down too. Your uptime can't beat the weakest part you depend on, and it's usually lower. Measure it where your customers are, with a check that loads your app.
- Treating the credit as the cost. An SLA credit is usually a share of that month's bill. It rarely covers the customers you lost while you were down.

## Uptime for a small live chat team

For live chat, a few minutes down hurts less than a few minutes of broken checkout. What matters more is that no message gets lost. In Dinghy, a visitor's message and its event save in one database transaction, and the widget catches up from where it left off after a reconnect. If you [self-host Dinghy](/docs/self-hosting), your host's SLA covers the server, not your deploys or your config. Point an uptime monitor at your Dinghy server so you hear about outages before your visitors do.

## FAQ

### How much downtime is 99.9% uptime?

About 1 minute 26 seconds a day, 10 minutes a week, 43 minutes 50 seconds a month and 8 hours 46 minutes a year.

### How much downtime is 99.99% uptime?

About 8.6 seconds a day, 1 minute a week, 4 minutes 23 seconds a month and 52 minutes 36 seconds a year.

### What does "five nines" mean?

99.999% uptime. It allows about 26 seconds of downtime a month and 5 minutes 16 seconds a year.

### How do I calculate uptime from downtime?

Subtract the downtime from the length of the period, divide by the length of the period, and multiply by 100. Switch the calculator above to downtime to do it for a day, week, month or year.
