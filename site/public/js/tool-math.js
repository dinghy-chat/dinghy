// The math behind the free calculators. Pure functions, so tests/tools.test.ts can check them.

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_YEAR = 365.25;
const MAX_AGENTS = 10_000;

/** Downtime periods in seconds. A month is a twelfth of an average year. */
const PERIOD_SECONDS = {
  day: SECONDS_PER_DAY,
  week: 7 * SECONDS_PER_DAY,
  month: (DAYS_PER_YEAR * SECONDS_PER_DAY) / 12,
  year: DAYS_PER_YEAR * SECONDS_PER_DAY,
};

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

/** CSAT as the percent of responses that were satisfied, or null with no responses. */
export function csat(satisfied, total) {
  if (total <= 0 || satisfied < 0 || satisfied > total) return null;
  return share(satisfied, total);
}

/** Average handle time in minutes, or null with no conversations. */
export function aht(chatMinutes, wrapUpMinutes, conversations) {
  if (conversations <= 0) return null;
  return (chatMinutes + wrapUpMinutes) / conversations;
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

/** A length of time in seconds as text, such as "1 h 26 min 24 s". */
export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "never";
  if (totalSeconds > 0 && totalSeconds < 0.05) return "under 0.1 s";
  if (totalSeconds < 10) return `${Number(totalSeconds.toFixed(1))} s`;
  const rounded = Math.round(totalSeconds);
  const units = [
    ["d", Math.floor(rounded / SECONDS_PER_DAY)],
    ["h", Math.floor((rounded % SECONDS_PER_DAY) / 3600)],
    ["min", Math.floor((rounded % 3600) / SECONDS_PER_MINUTE)],
    ["s", rounded % SECONDS_PER_MINUTE],
  ];
  return units
    .filter(([, value]) => value > 0)
    .map(([unit, value]) => `${value} ${unit}`)
    .join(" ");
}
