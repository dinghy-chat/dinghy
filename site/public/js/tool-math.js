// The math behind the free calculators. Pure functions, so tests/tools.test.ts can check them.

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_YEAR = 365.25;
const MAX_AGENTS = 10_000;

/** Downtime periods in seconds. A month is a twelfth of an average year. */
export const PERIOD_SECONDS = {
  day: SECONDS_PER_DAY,
  week: 7 * SECONDS_PER_DAY,
  month: (DAYS_PER_YEAR * SECONDS_PER_DAY) / 12,
  year: DAYS_PER_YEAR * SECONDS_PER_DAY,
};

/** The benchmarks the tools pages cite, with their sources named on each page. */
export const BENCHMARKS = {
  /** Retently's 2026 NPS averages. */
  npsSaas: 41,
  npsEcommerce: 61,
  /** Comm100's 2025 report, live chat CSAT in 2024. */
  csatChat: 79.9,
  /** LiveChat's average chat, and Comm100's for teams of 1 to 5 agents. */
  chatMinutesLow: 505 / SECONDS_PER_MINUTE,
  chatMinutesHigh: 625 / SECONDS_PER_MINUTE,
};

/** Common SLA levels, the uptime calculator's presets. */
const SLA_LEVELS = [99, 99.5, 99.9, 99.95, 99.99, 99.999];

/** What the clouds on the uptime page promise each month, highest first. */
const CLOUD_PROMISES = [
  { level: 99.99, promise: "AWS and Google promise", what: "servers in more than one zone" },
  { level: 99.9, promise: "Google promises", what: "one Compute Engine instance" },
  { level: 99.5, promise: "AWS promises", what: "one EC2 instance" },
];

const share = (part, total) => (part / total) * 100;

/** Net Promoter Score from response counts, or null with no responses. */
export function nps(promoters, passives, detractors) {
  const total = promoters + passives + detractors;
  if (total <= 0) return null;
  return {
    total,
    promoters: share(promoters, total),
    passives: share(passives, total),
    detractors: share(detractors, total),
    score: share(promoters - detractors, total),
  };
}

/** A plain-words reading of an NPS, against the benchmarks the NPS page cites. */
export function npsVerdict(score) {
  if (score > BENCHMARKS.npsEcommerce)
    return { tone: "good", text: "Above the ecommerce average of 61, and the B2B SaaS average of 41." };
  if (score > BENCHMARKS.npsSaas) return { tone: "good", text: "Above the B2B SaaS average of 41." };
  if (score > 0) return { tone: "fair", text: "More promoters than detractors. That's good." };
  if (score === 0) return { tone: "fair", text: "As many detractors as promoters." };
  return { tone: "poor", text: "More detractors than promoters. Read what they wrote first." };
}

/** CSAT as the percent of responses that were satisfied, or null with no responses. */
export function csat(satisfied, total) {
  if (total <= 0 || satisfied < 0 || satisfied > total) return null;
  return share(satisfied, total);
}

/** A plain-words reading of a CSAT percent, against the live chat average. */
export function csatVerdict(percent) {
  if (percent > BENCHMARKS.csatChat)
    return { tone: "good", text: "Above the 79.9% live chat average in Comm100's report." };
  if (percent === BENCHMARKS.csatChat) return { tone: "fair", text: "Level with the 79.9% live chat average." };
  if (percent >= 50)
    return { tone: "fair", text: "Below the 79.9% live chat average. The comments on low ratings say what to fix." };
  return { tone: "poor", text: "Fewer than half were satisfied. The comments on low ratings say what to fix." };
}

/** Average handle time in minutes, or null with no conversations. */
export function aht(chatMinutes, wrapUpMinutes, conversations) {
  if (conversations <= 0) return null;
  return (chatMinutes + wrapUpMinutes) / conversations;
}

/** A plain-words reading of the chat part of AHT. The benchmarks leave out wrap-up. */
export function ahtVerdict(chatMinutesEach) {
  if (chatMinutesEach < BENCHMARKS.chatMinutesLow)
    return { tone: "info", text: "Your chats are shorter than the 8 min 25 s average in LiveChat's report." };
  if (chatMinutesEach <= BENCHMARKS.chatMinutesHigh)
    return { tone: "info", text: "Your chats last about as long as the benchmarks, 8 to 10 minutes." };
  return { tone: "info", text: "Your chats run longer than the 10 min 25 s Comm100 found for teams of 1 to 5." };
}

/** Allowed downtime in seconds for each period at an uptime percent. */
export function downtimeFor(uptimePercent) {
  const down = 1 - uptimePercent / 100;
  return {
    day: PERIOD_SECONDS.day * down,
    week: PERIOD_SECONDS.week * down,
    month: PERIOD_SECONDS.month * down,
    year: PERIOD_SECONDS.year * down,
  };
}

/** Uptime percent after some downtime in a period, or null when the downtime does not fit. */
export function uptimeFor(downtimeSeconds, period) {
  const length = PERIOD_SECONDS[period];
  if (downtimeSeconds < 0 || downtimeSeconds > length) return null;
  return share(length - downtimeSeconds, length);
}

/** How an uptime percent compares with what the big clouds promise. */
export function uptimeVerdict(uptimePercent) {
  const promise = CLOUD_PROMISES.find((cloud) => uptimePercent >= cloud.level);
  if (!promise) return { tone: "info", text: "Less than AWS promises for one EC2 instance, 99.5%." };
  if (uptimePercent === promise.level)
    return { tone: "info", text: `What ${promise.promise} for ${promise.what}.` };
  return { tone: "info", text: `More than ${promise.promise} for ${promise.what}, ${promise.level}%.` };
}

/** Each SLA level, whether some downtime in a period meets it, and by how many seconds. */
export function slaLadder(downtimeSeconds, period) {
  return SLA_LEVELS.map((level) => {
    const allowed = downtimeFor(level)[period];
    return { level, isMet: downtimeSeconds <= allowed, marginSeconds: Math.abs(allowed - downtimeSeconds) };
  });
}

/** The highest SLA some downtime meets, and the next one it misses, in words. */
export function slaVerdict(downtimeSeconds, period) {
  const ladder = slaLadder(downtimeSeconds, period);
  const missed = ladder.find((rung) => !rung.isMet);
  const met = ladder.findLast((rung) => rung.isMet);
  if (!missed) return { tone: "good", text: `Meets even a ${met.level}% SLA.` };
  const miss = `${missed.level}% by ${formatDuration(missed.marginSeconds)}`;
  if (!met) return { tone: "poor", text: `Misses a ${missed.level}% SLA by ${formatDuration(missed.marginSeconds)}.` };
  return { tone: "fair", text: `Meets a ${met.level}% SLA. Misses ${miss}.` };
}

/**
 * The Erlang C chance that a new arrival waits, for `servers` servers and `traffic` erlangs.
 * @public The test checks it against a published worked example.
 */
export function erlangC(servers, traffic) {
  if (servers <= traffic) return 1;
  let blocking = 1;
  for (let k = 1; k <= servers; k += 1) blocking = (traffic * blocking) / (k + traffic * blocking);
  return (servers * blocking) / (servers - traffic * (1 - blocking));
}

/**
 * Service level and average wait for a number of agents, each with `concurrency` chat slots.
 * @public The test checks it against a published worked example.
 */
export function serviceFor(agents, load) {
  const servers = agents * load.concurrency;
  const traffic = (load.perHour * load.handleMinutes) / MINUTES_PER_HOUR;
  const handleSeconds = load.handleMinutes * SECONDS_PER_MINUTE;
  const waitChance = erlangC(servers, traffic);
  if (servers <= traffic) return { waitChance, serviceLevel: 0, averageWaitSeconds: Infinity };
  return {
    waitChance,
    serviceLevel:
      100 *
      (1 - waitChance * Math.exp((-(servers - traffic) * load.targetSeconds) / handleSeconds)),
    averageWaitSeconds: (waitChance * handleSeconds) / (servers - traffic),
  };
}

/**
 * The fewest agents on shift that reach the target service level, and the headcount after
 * shrinkage. Null when the inputs make no sense or need more than MAX_AGENTS.
 */
export function staffing(load) {
  const { perHour, handleMinutes, concurrency, targetSeconds, targetPercent, shrinkagePercent } =
    load;
  if (perHour <= 0 || handleMinutes <= 0 || concurrency < 1 || targetSeconds < 0) return null;
  if (targetPercent <= 0 || targetPercent >= 100 || shrinkagePercent < 0 || shrinkagePercent >= 100)
    return null;
  const traffic = (perHour * handleMinutes) / MINUTES_PER_HOUR;
  for (
    let agents = Math.max(1, Math.floor(traffic / concurrency));
    agents <= MAX_AGENTS;
    agents += 1
  ) {
    const service = serviceFor(agents, load);
    if (service.serviceLevel >= targetPercent) {
      return {
        traffic,
        agents,
        scheduled: Math.ceil(((agents * 100) / (100 - shrinkagePercent)).toFixed(9)),
        occupancy: (100 * traffic) / (agents * concurrency),
        ...service,
      };
    }
  }
  return null;
}

/** A length of time in seconds as value and unit pairs, such as [["1", "h"], ["26", "min"]]. */
export function durationParts(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return [["never", ""]];
  if (totalSeconds > 0 && totalSeconds < 0.05) return [["under 0.1", "s"]];
  if (totalSeconds < 10) return [[String(Number(totalSeconds.toFixed(1))), "s"]];
  const rounded = Math.round(totalSeconds);
  const units = [
    ["d", Math.floor(rounded / SECONDS_PER_DAY)],
    ["h", Math.floor((rounded % SECONDS_PER_DAY) / 3600)],
    ["min", Math.floor((rounded % 3600) / SECONDS_PER_MINUTE)],
    ["s", rounded % SECONDS_PER_MINUTE],
  ];
  return units.filter(([, value]) => value > 0).map(([unit, value]) => [String(value), unit]);
}

/** A length of time in seconds as text, such as "1 h 26 min 24 s". */
export function formatDuration(totalSeconds) {
  return durationParts(totalSeconds)
    .map(([value, unit]) => (unit ? `${value} ${unit}` : value))
    .join(" ");
}

const LOG_SCALE_MIN_SECONDS = 0.1;

/** Where a duration sits from 0 to 1 on a log scale from a tenth of a second to a year. */
export function logShare(seconds) {
  if (seconds <= LOG_SCALE_MIN_SECONDS) return 0;
  const span = Math.log10(PERIOD_SECONDS.year / LOG_SCALE_MIN_SECONDS);
  return Math.min(1, Math.log10(seconds / LOG_SCALE_MIN_SECONDS) / span);
}

const AXIS_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 960];
const MAX_AXIS_TICKS = 4;

/** A round axis end and tick step that fit a value, with at most four steps. */
export function axisFor(value) {
  const step = AXIS_STEPS.find((candidate) => value / candidate <= MAX_AXIS_TICKS) ?? 10 ** Math.ceil(Math.log10(value / MAX_AXIS_TICKS));
  return { end: Math.max(step, Math.ceil(value / step) * step), step };
}

const QUERY_NUMBER = /^\d{1,12}(\.\d{1,8})?$/;

/**
 * The values a query string gives for a tool's fields. `fields` maps each name to "number" or to
 * the values it accepts. Anything else in the query is dropped.
 */
export function parseQuery(search, fields) {
  const params = new URLSearchParams(search);
  const values = {};
  for (const [name, accepts] of Object.entries(fields)) {
    const value = params.get(name);
    if (value === null) continue;
    if (accepts === "number" ? QUERY_NUMBER.test(value) : accepts.includes(value)) values[name] = value;
  }
  return values;
}
