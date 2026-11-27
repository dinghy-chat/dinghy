// The free tools: a content page, plus the calculator on it.
import "./page.js";
import {
  aht,
  ahtVerdict,
  axisFor,
  BENCHMARKS,
  csat,
  csatVerdict,
  downtimeFor,
  durationParts,
  formatDuration,
  logShare,
  nps,
  npsVerdict,
  PERIOD_SECONDS,
  parseQuery,
  slaLadder,
  slaVerdict,
  staffing,
  uptimeFor,
  uptimeVerdict,
} from "./tool-math.js";

const URL_WRITE_DELAY_MS = 300;
const COPIED_LABEL_MS = 1800;
const FACE_COUNT = 20;
const MAX_FLEET = 48;
const PERIODS = ["day", "week", "month", "year"];
const PERIOD_NAMES = { day: "Per day", week: "Per week", month: "Per month", year: "Per year" };
const LOG_TICKS = [
  [1, "1 s"],
  [60, "1 min"],
  [3600, "1 h"],
  [86_400, "1 day"],
  [31_557_600, "1 year"],
];

const numberText = (value, digits = 1) =>
  Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
const percentText = (value, digits = 1) => `${numberText(value, digits)}%`;
const signedText = (value) => (value > 0 ? `+${numberText(value)}` : numberText(value));
const plural = (count, one, many) => `${numberText(count, 0)} ${count === 1 ? one : many}`;
const pct = (share) => `${Math.max(0, Math.min(100, share))}%`;

const ICONS = {
  boat: '<svg viewBox="0 0 32 32"><path class="sail" d="M15 3v18H5z"/><path class="sail" d="M17 8v13h8z"/><path class="hull" d="M2 23h28l-4.5 6h-19z"/></svg>',
  face: '<svg viewBox="0 0 24 24"><circle class="head" cx="12" cy="12" r="10.5"/><circle class="eye" cx="8.6" cy="10" r="1.5"/><circle class="eye" cx="15.4" cy="10" r="1.5"/><path class="smile" d="M7.6 14.2q4.4 4.4 8.8 0"/><path class="flat" d="M8.4 15.4h7.2"/></svg>',
  minus: '<svg viewBox="0 0 20 20"><path d="M4 10h12"/></svg>',
  plus: '<svg viewBox="0 0 20 20"><path d="M4 10h12M10 4v12"/></svg>',
  copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>',
  link: '<svg viewBox="0 0 20 20"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3L15 6.5"/></svg>',
  cross: '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
};

/** Fills an empty visual with its skeleton once, so later updates can animate. */
function skeleton(visual, html) {
  if (!visual.firstElementChild) visual.innerHTML = html;
  return (selector) => visual.querySelector(selector);
}

const setVar = (element, name, value) => element.style.setProperty(name, value);

/** Places each [data-at] mark along a track, as a percent of the track. */
function placeMarks(visual, toShare) {
  for (const mark of visual.querySelectorAll("[data-at]")) setVar(mark, "--at", pct(toShare(Number(mark.dataset.at))));
}

const scaleLabel = (at, text, side) => `<span data-at="${at}" class="${side}">${text}</span>`;

function drawNps(visual, result) {
  const find = skeleton(
    visual,
    `<div class="viz-split" aria-hidden="true"><i class="is-good"></i><i class="is-fair"></i><i class="is-poor"></i></div>
    <div class="viz-scale" aria-hidden="true">
      <div class="viz-ends"><span>-100</span><span>+100</span></div>
      <div class="viz-track"><i class="viz-fill"></i><i class="viz-tick" data-at="0"></i><i class="viz-tick is-soft" data-at="${BENCHMARKS.npsSaas}"></i><i class="viz-tick is-soft" data-at="${BENCHMARKS.npsEcommerce}"></i><span class="viz-pin">${ICONS.boat}</span></div>
      <div class="viz-labels">${scaleLabel(0, "0", "")}${scaleLabel(BENCHMARKS.npsSaas, "41", "is-before")}${scaleLabel(BENCHMARKS.npsEcommerce, "61", "is-after")}</div>
    </div>`,
  );
  const toShare = (score) => (score + 100) / 2;
  placeMarks(visual, toShare);
  const [good, fair, poor] = find(".viz-split").children;
  setVar(poor, "--share", pct(result.detractors));
  setVar(fair, "--share", pct(result.passives));
  setVar(good, "--share", pct(result.promoters));
  const at = toShare(result.score);
  setVar(find(".viz-pin"), "--at", pct(at));
  const fill = find(".viz-fill");
  setVar(fill, "--from", pct(Math.min(50, at)));
  setVar(fill, "--size", pct(Math.abs(at - 50)));
  fill.dataset.tone = result.score < 0 ? "poor" : "good";
}

function meter(label, at) {
  const side = at > 50 ? "is-before" : "is-after";
  return `<div class="viz-labels is-above">${scaleLabel(at, label, side)}</div><div class="viz-track"><i class="viz-fill"></i><i class="viz-tick" data-at="${at}"></i></div>`;
}

function drawCsat(visual, percent) {
  const find = skeleton(
    visual,
    `<div class="viz-faces" aria-hidden="true">${`<span class="viz-face">${ICONS.face}</span>`.repeat(FACE_COUNT)}</div>
    <p class="viz-caption" data-caption></p>
    <div class="viz-meter" aria-hidden="true">${meter("Live chat average 79.9%", BENCHMARKS.csatChat)}</div>`,
  );
  placeMarks(visual, (value) => value);
  const happy = Math.round((percent / 100) * FACE_COUNT);
  for (const [index, face] of [...find(".viz-faces").children].entries()) {
    face.classList.toggle("is-happy", index < happy);
  }
  find("[data-caption]").textContent = `About ${happy} in ${FACE_COUNT} people were satisfied.`;
  const fill = find(".viz-fill");
  setVar(fill, "--size", pct(percent));
  fill.dataset.tone = percent >= BENCHMARKS.csatChat ? "good" : "fair";
}

function drawAht(visual, chatEach, wrapEach) {
  const total = chatEach + wrapEach;
  const axis = axisFor(Math.max(total, BENCHMARKS.chatMinutesHigh) * 1.1);
  const ticks = Array.from({ length: axis.end / axis.step + 1 }, (_, index) => index * axis.step);
  const toShare = (minutes) => (minutes / axis.end) * 100;
  if (visual.dataset.end === String(axis.end)) return updateAht(visual, toShare, chatEach, wrapEach);
  visual.dataset.end = String(axis.end);
  visual.innerHTML = `<div class="viz-band-row" aria-hidden="true"><span class="viz-band"><span>Benchmark chat length</span></span></div>
    <div class="viz-stack" aria-hidden="true"><i class="is-chat"></i><i class="is-wrap"></i></div>
    <div class="viz-labels" aria-hidden="true">${ticks.map((tick) => scaleLabel(tick, tick === 0 ? "0" : `${tick} min`, tick === axis.end ? "is-before" : tick === 0 ? "is-after" : "")).join("")}</div>`;
  placeMarks(visual, toShare);
  const band = visual.querySelector(".viz-band");
  setVar(band, "--from", pct(toShare(BENCHMARKS.chatMinutesLow)));
  setVar(band, "--size", pct(toShare(BENCHMARKS.chatMinutesHigh - BENCHMARKS.chatMinutesLow)));
  updateAht(visual, toShare, chatEach, wrapEach);
}

function updateAht(visual, toShare, chatEach, wrapEach) {
  const [chat, wrap] = visual.querySelector(".viz-stack").children;
  setVar(chat, "--size", pct(toShare(chatEach)));
  setVar(wrap, "--size", pct(toShare(wrapEach)));
}

function syncFleet(fleet, onChat, cover) {
  const shown = Math.min(onChat + cover, MAX_FLEET);
  while (fleet.children.length > shown) fleet.lastElementChild.remove();
  while (fleet.children.length < shown) {
    const boat = document.createElement("span");
    boat.innerHTML = ICONS.boat;
    fleet.append(boat);
  }
  for (const [index, boat] of [...fleet.children].entries()) boat.classList.toggle("is-cover", index >= onChat);
}

function drawStaffing(visual, result, input) {
  const find = skeleton(
    visual,
    `<div class="viz-fleet" aria-hidden="true"></div>
    <div class="viz-legend"><span class="is-on" data-on></span><span class="is-cover" data-cover></span><span data-more></span></div>
    <p class="viz-caption is-lead" data-service></p>
    <div class="viz-meter" aria-hidden="true"></div>`,
  );
  find("[data-service]").textContent = `${percentText(result.serviceLevel)} of chats picked up within ${formatDuration(input.targetSeconds)}`;
  const cover = result.scheduled - result.agents;
  syncFleet(find(".viz-fleet"), result.agents, cover);
  find("[data-on]").textContent = `${numberText(result.agents, 0)} on chat`;
  find("[data-cover]").textContent = `${numberText(cover, 0)} to cover shrinkage`;
  const hidden = result.scheduled - MAX_FLEET;
  find("[data-more]").textContent = hidden > 0 ? `${numberText(hidden, 0)} more not drawn` : "";
  const meterBox = find(".viz-meter");
  if (meterBox.dataset.target !== String(input.targetPercent)) {
    meterBox.dataset.target = String(input.targetPercent);
    meterBox.innerHTML = meter(`Target ${percentText(input.targetPercent)}`, input.targetPercent);
    placeMarks(meterBox, (value) => value);
  }
  const fill = meterBox.querySelector(".viz-fill");
  setVar(fill, "--size", pct(result.serviceLevel));
  fill.dataset.tone = "good";
}

function drawUptime(visual, down) {
  const find = skeleton(
    visual,
    `<dl class="viz-ruler">${PERIODS.map(
      (period) =>
        `<div class="viz-row${period === "month" ? " is-hero" : ""}"><dt>${PERIOD_NAMES[period]}</dt><dd><b data-period="${period}"></b><span class="viz-track" aria-hidden="true">${LOG_TICKS.map(([seconds]) => `<i class="viz-grid" data-at="${seconds}"></i>`).join("")}<i class="viz-fill"></i></span></dd></div>`,
    ).join("")}</dl>
    <div class="viz-labels" aria-hidden="true">${LOG_TICKS.map(([seconds, label], index) => scaleLabel(seconds, label, index === LOG_TICKS.length - 1 ? "is-before" : "")).join("")}</div>
    <p class="viz-caption">The bars use a log scale, so short outages still show.</p>`,
  );
  placeMarks(visual, (seconds) => logShare(seconds) * 100);
  for (const period of PERIODS) {
    const value = find(`[data-period="${period}"]`);
    value.textContent = formatDuration(down[period]);
    setVar(value.nextElementSibling.querySelector(".viz-fill"), "--size", pct(logShare(down[period]) * 100));
  }
}

function drawLadder(visual, ladder) {
  visual.innerHTML = `<div class="viz-ladder">${ladder
    .map(
      (rung) =>
        `<p class="viz-rung${rung.isMet ? " is-met" : ""}"><span class="viz-rung-icon" aria-hidden="true">${rung.isMet ? ICONS.check : ICONS.cross}</span><b>${rung.level}%</b><span>${rung.isMet ? `${formatDuration(rung.marginSeconds)} to spare` : `Missed by ${formatDuration(rung.marginSeconds)}`}</span></p>`,
    )
    .join("")}</div>`;
}

/**
 * Each tool reads its inputs by name and returns what to show, or null when they make no sense:
 * text for each [data-out], a verdict, a summary to copy and a function that draws the visual.
 */
const TOOLS = {
  nps: (input) => {
    const result = nps(input.promoters, input.passives, input.detractors);
    if (!result) return null;
    const score = signedText(result.score);
    return {
      out: {
        score,
        promoters: percentText(result.promoters),
        passives: percentText(result.passives),
        detractors: percentText(result.detractors),
        total: numberText(result.total, 0),
        swing: `${numberText(200 / result.total)} points`,
      },
      verdict: npsVerdict(result.score),
      summary: `NPS ${score} from ${plural(result.total, "response", "responses")}: ${percentText(result.promoters)} promoters, ${percentText(result.passives)} passives and ${percentText(result.detractors)} detractors.`,
      draw: (visual) => drawNps(visual, result),
    };
  },
  csat: (input) => {
    const result = csat(input.satisfied, input.total);
    if (result === null) return null;
    return {
      out: {
        score: percentText(result),
        satisfied: numberText(input.satisfied, 0),
        total: numberText(input.total, 0),
        unhappy: numberText(input.total - input.satisfied, 0),
        swing: `${numberText(100 / input.total, 2)} points`,
      },
      verdict: csatVerdict(result),
      summary: `CSAT ${percentText(result)}: ${numberText(input.satisfied, 0)} of ${plural(input.total, "rating", "ratings")} were satisfied.`,
      draw: (visual) => drawCsat(visual, result),
    };
  },
  aht: (input) => {
    const minutes = aht(input.chat, input.wrapUp, input.conversations);
    if (minutes === null) return null;
    const chatEach = input.chat / input.conversations;
    const wrapEach = input.wrapUp / input.conversations;
    return {
      out: {
        aht: durationParts(minutes * 60),
        ahtText: formatDuration(minutes * 60),
        chat: numberText(input.chat),
        wrapUp: numberText(input.wrapUp),
        conversations: numberText(input.conversations, 0),
        chatEach: formatDuration(chatEach * 60),
        wrapEach: formatDuration(wrapEach * 60),
        perHour: minutes > 0 ? numberText(60 / minutes) : "",
      },
      verdict: ahtVerdict(chatEach),
      summary: `Average handle time ${formatDuration(minutes * 60)}, over ${plural(input.conversations, "conversation", "conversations")}.`,
      draw: (visual) => drawAht(visual, chatEach, wrapEach),
      links: { handleMinutes: numberText(minutes, 2) },
    };
  },
  uptime: (input) => {
    if (input.uptime < 0 || input.uptime > 100) return null;
    const down = downtimeFor(input.uptime);
    const text = (period) => formatDuration(down[period]);
    return {
      out: {
        month: durationParts(down.month),
        monthText: text("month"),
        downShare: `${numberText(100 - input.uptime, 6)}%`,
      },
      verdict: uptimeVerdict(input.uptime),
      summary: `${numberText(input.uptime, 6)}% uptime allows ${text("day")} of downtime a day, ${text("week")} a week, ${text("month")} a month and ${text("year")} a year.`,
      draw: (visual) => drawUptime(visual, down),
    };
  },
  downtime: (input) => {
    const seconds = input.hours * 3600 + input.minutes * 60 + input.seconds;
    const result = uptimeFor(seconds, input.period);
    if (result === null) return null;
    const uptime = percentText(result, 4);
    const shown = seconds > 0 && uptime === "100%" ? "99.9999%+" : uptime;
    return {
      out: {
        uptime: shown,
        period: input.period,
        periodSeconds: numberText(PERIOD_SECONDS[input.period], 0),
        downSeconds: numberText(seconds),
      },
      verdict: slaVerdict(seconds, input.period),
      summary: `${formatDuration(seconds)} of downtime in a ${input.period} is ${shown} uptime.`,
      draw: (visual) => drawLadder(visual, slaLadder(seconds, input.period)),
    };
  },
  staffing: (input) => {
    const result = staffing(input);
    if (!result) return null;
    return {
      out: {
        agents: numberText(result.agents, 0),
        wait: formatDuration(result.averageWaitSeconds),
        occupancy: percentText(result.occupancy, 0),
        traffic: numberText(result.traffic, 2),
      },
      verdict: {
        tone: "info",
        text: `Schedule ${plural(result.scheduled, "person", "people")} so ${numberText(result.agents, 0)} ${result.agents === 1 ? "is" : "are"} on chat after breaks and time off.`,
      },
      summary: `${input.perHour} chats an hour at ${input.handleMinutes} min each, ${input.concurrency} at once: ${plural(result.agents, "person", "people")} on chat and ${numberText(result.scheduled, 0)} on the schedule. ${percentText(result.serviceLevel)} of chats picked up within ${formatDuration(input.targetSeconds)}.`,
      draw: (visual) => drawStaffing(visual, result, input),
    };
  },
};

/** The inputs by name, or null when a field is empty or breaks its min, max or step. */
function readInputs(pane) {
  const input = {};
  let isValid = true;
  for (const field of pane.querySelectorAll("input[name]")) {
    if (field.type === "radio") {
      if (field.checked) input[field.name] = field.value;
      continue;
    }
    const isFieldValid = field.value !== "" && field.validity.valid;
    if (isFieldValid) field.removeAttribute("aria-invalid");
    else field.setAttribute("aria-invalid", "true");
    isValid &&= isFieldValid;
    input[field.name] = field.valueAsNumber;
  }
  return isValid ? input : null;
}

/** Shows a number, or a duration as big values with small units. */
function showValue(target, value) {
  if (!Array.isArray(value)) {
    target.textContent = value;
    return value.length;
  }
  target.replaceChildren(
    ...value.flatMap(([amount, unit]) => {
      const small = document.createElement("small");
      small.textContent = unit;
      return [amount, small];
    }),
  );
  return value.reduce((chars, [amount, unit]) => chars + amount.length + unit.length * 0.45 + 0.4, 0);
}

function update(pane) {
  const input = readInputs(pane);
  const result = input && TOOLS[pane.dataset.tool](input);
  pane.querySelector("[data-error]").hidden = Boolean(result);
  pane.classList.toggle("is-invalid", !result);
  syncControls(pane);
  if (!result) return;
  for (const target of pane.querySelectorAll("[data-out]")) {
    const chars = showValue(target, result.out[target.dataset.out] ?? "");
    if (target.classList.contains("tool-big")) setVar(target, "--chars", String(Math.max(3, chars)));
  }
  const verdict = pane.querySelector("[data-verdict]");
  verdict.textContent = result.verdict.text;
  verdict.dataset.tone = result.verdict.tone;
  result.draw(pane.querySelector("[data-visual]"));
  for (const link of pane.querySelectorAll("a[data-link]")) {
    link.search = new URLSearchParams(result.links).toString();
  }
  pane.dataset.summary = result.summary;
}

/** Keeps each slider and preset chip in step with its number field. */
function syncControls(pane) {
  for (const range of pane.querySelectorAll("[data-for]")) {
    const field = pane.querySelector(`[name="${range.dataset.for}"]`);
    if (field.value !== "" && document.activeElement !== range) range.value = field.value;
    setVar(range, "--fill", pct(((range.valueAsNumber - range.min) / (range.max - range.min)) * 100));
  }
  for (const chip of pane.querySelectorAll("[data-preset]")) {
    const field = pane.querySelector(`[name="${chip.dataset.preset}"]`);
    chip.setAttribute("aria-pressed", String(field.valueAsNumber === Number(chip.value)));
  }
}

function setField(field, value) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function addSteppers(card) {
  for (const box of card.querySelectorAll(".tool-input[data-stepper]")) {
    const field = box.querySelector("input");
    const name = box.closest(".tool-field").querySelector(".tool-label b").textContent.toLowerCase();
    const button = (delta, icon, label) => {
      const step = document.createElement("button");
      step.type = "button";
      step.className = "tool-step";
      step.tabIndex = -1;
      step.setAttribute("aria-label", `${label} ${name}`);
      step.innerHTML = icon;
      step.addEventListener("click", () => {
        const next = (Number.isNaN(field.valueAsNumber) ? 0 : field.valueAsNumber) + delta;
        setField(field, String(Math.max(Number(field.min || 0), Math.round(next))));
      });
      return step;
    };
    box.prepend(button(-1, ICONS.minus, "Less"));
    box.append(button(1, ICONS.plus, "More"));
  }
}

function fieldSpec(card) {
  const spec = {};
  for (const field of card.querySelectorAll("input[name]")) {
    spec[field.name] = field.type === "radio" ? [...(spec[field.name] ?? []), field.value] : "number";
  }
  return spec;
}

function applyQuery(card) {
  const values = parseQuery(location.search, fieldSpec(card));
  for (const field of card.querySelectorAll("input[name]")) {
    const value = values[field.name];
    if (value === undefined) continue;
    if (field.type === "radio") field.checked = field.value === value;
    else field.value = value;
  }
}

function writeQuery(card) {
  const params = new URLSearchParams();
  for (const field of card.querySelectorAll("input[name]")) {
    if (field.closest("[hidden]") || (field.type === "radio" && !field.checked)) continue;
    params.set(field.name, field.value);
  }
  history.replaceState(history.state, "", `${location.pathname}?${params}${location.hash}`);
}

function showMode(card) {
  const mode = card.querySelector('input[name="mode"]:checked')?.value;
  if (!mode) return;
  for (const pane of card.querySelectorAll("[data-tool]")) pane.hidden = pane.dataset.tool !== mode;
}

async function copy(card, button) {
  writeQuery(card);
  const pane = button.closest("[data-tool]");
  const text = button.dataset.share === "link" ? location.href : `${pane.dataset.summary}\n${location.href}`;
  const label = button.querySelector("span");
  button.dataset.label ??= label.textContent;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = "Copied";
  } catch {
    label.textContent = "Copy failed";
  }
  pane.querySelector("[data-status]").textContent = label.textContent;
  setTimeout(() => {
    label.textContent = button.dataset.label;
  }, COPIED_LABEL_MS);
}

function decorateButtons(card) {
  for (const button of card.querySelectorAll("[data-share]")) {
    const label = document.createElement("span");
    label.textContent = button.textContent;
    button.innerHTML = button.dataset.share === "link" ? ICONS.link : ICONS.copy;
    button.append(label);
  }
}

function setUp(card) {
  applyQuery(card);
  showMode(card);
  addSteppers(card);
  decorateButtons(card);
  let writeTimer = 0;
  card.addEventListener("input", (event) => {
    const field = event.target;
    const pane = field.closest("[data-tool]");
    if (field.dataset.for) setField(pane.querySelector(`[name="${field.dataset.for}"]`), field.value);
    else if (pane) update(pane);
    else showMode(card);
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => writeQuery(card), URL_WRITE_DELAY_MS);
  });
  card.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-share], button[data-preset]");
    if (!button) return;
    if (button.dataset.share) copy(card, button);
    else setField(button.closest("[data-tool]").querySelector(`[name="${button.dataset.preset}"]`), button.value);
  });
  for (const pane of card.querySelectorAll("[data-tool]")) update(pane);
}

for (const card of document.querySelectorAll(".tool")) setUp(card);
