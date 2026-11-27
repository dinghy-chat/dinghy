import { describe, expect, test } from "vitest";

type Period = "day" | "week" | "month" | "year";
interface Load {
  perHour: number;
  handleMinutes: number;
  concurrency: number;
  targetSeconds: number;
  targetPercent: number;
  shrinkagePercent: number;
}
interface Service {
  waitChance: number;
  serviceLevel: number;
  averageWaitSeconds: number;
}
type Tone = "good" | "fair" | "poor" | "info";
interface Verdict {
  tone: Tone;
  text: string;
}
interface Rung {
  level: number;
  isMet: boolean;
  marginSeconds: number;
}
interface ToolMath {
  npsVerdict(score: number): Verdict;
  csatVerdict(percent: number): Verdict;
  ahtVerdict(chatMinutesEach: number): Verdict;
  uptimeVerdict(uptimePercent: number): Verdict;
  slaLadder(downtimeSeconds: number, period: Period): Rung[];
  slaVerdict(downtimeSeconds: number, period: Period): Verdict;
  durationParts(totalSeconds: number): [string, string][];
  logShare(seconds: number): number;
  axisFor(value: number): { end: number; step: number };
  parseQuery(search: string, fields: Record<string, "number" | string[]>): Record<string, string>;
  nps(
    promoters: number,
    passives: number,
    detractors: number,
  ): {
    total: number;
    promoters: number;
    passives: number;
    detractors: number;
    score: number;
  } | null;
  csat(satisfied: number, total: number): number | null;
  aht(chatMinutes: number, wrapUpMinutes: number, conversations: number): number | null;
  downtimeFor(uptimePercent: number): Record<Period, number>;
  uptimeFor(downtimeSeconds: number, period: Period): number | null;
  erlangC(servers: number, traffic: number): number;
  serviceFor(agents: number, load: Load): Service;
  staffing(
    load: Load,
  ): (Service & { traffic: number; agents: number; scheduled: number; occupancy: number }) | null;
  formatDuration(totalSeconds: number): string;
}

// The site's scripts are plain JavaScript that TypeScript does not check, so the test names their types.
const MATH_PATH = "../site/public/js/tool-math.js";
const math = (await import(MATH_PATH)) as ToolMath;

describe("NPS", () => {
  test("is the promoter share minus the detractor share", () => {
    expect(math.nps(60, 25, 15)).toEqual({
      total: 100,
      promoters: 60,
      passives: 25,
      detractors: 15,
      score: 45,
    });
  });

  test("runs from -100 to 100", () => {
    expect(math.nps(0, 0, 8)?.score).toBe(-100);
    expect(math.nps(8, 0, 0)?.score).toBe(100);
  });

  test("has no score without responses", () => {
    expect(math.nps(0, 0, 0)).toBeNull();
  });
});

describe("CSAT", () => {
  test("is the share of satisfied responses", () => {
    expect(math.csat(170, 200)).toBe(85);
  });

  test("rejects more satisfied responses than responses", () => {
    expect(math.csat(5, 4)).toBeNull();
    expect(math.csat(0, 0)).toBeNull();
  });
});

describe("AHT", () => {
  test("adds wrap-up time to chat time and divides by conversations", () => {
    expect(math.aht(1200, 300, 150)).toBe(10);
    expect(math.aht(10, 0, 0)).toBeNull();
  });
});

describe("uptime", () => {
  test("99.9% allows 86.4 seconds a day and about 8.77 hours a year", () => {
    const down = math.downtimeFor(99.9);
    expect(down.day).toBeCloseTo(86.4, 6);
    expect(down.week).toBeCloseTo(604.8, 6);
    expect(down.month).toBeCloseTo(2629.8, 6);
    expect(down.year).toBeCloseTo(31_557.6, 6);
  });

  test("turns downtime back into a percent", () => {
    expect(math.uptimeFor(86.4, "day")).toBeCloseTo(99.9, 9);
    expect(math.uptimeFor(0, "month")).toBe(100);
    expect(math.uptimeFor(90_000, "day")).toBeNull();
  });
});

describe("formatDuration", () => {
  test("splits seconds into days, hours, minutes and seconds", () => {
    expect(math.formatDuration(31_557.6)).toBe("8 h 45 min 58 s");
    expect(math.formatDuration(86.4)).toBe("1 min 26 s");
    expect(math.formatDuration(8.64)).toBe("8.6 s");
  });

  test("never shows a short outage as zero", () => {
    expect(math.formatDuration(0.00864)).toBe("under 0.1 s");
    expect(math.formatDuration(0)).toBe("0 s");
  });
});

// Call Centre Helper's worked example: 100 calls in 30 minutes, 180 second handle time,
// 80% answered in 20 seconds, 30% shrinkage.
// https://www.callcentrehelper.com/erlang-c-formula-example-121281.htm
describe("Erlang C", () => {
  const load: Load = {
    perHour: 200,
    handleMinutes: 3,
    concurrency: 1,
    targetSeconds: 20,
    targetPercent: 80,
    shrinkagePercent: 30,
  };

  test("matches the published chance to wait for 11 to 14 agents", () => {
    expect(math.erlangC(11, 10)).toBeCloseTo(0.6821, 4);
    expect(math.erlangC(12, 10)).toBeCloseTo(0.4494, 4);
    expect(math.erlangC(13, 10)).toBeCloseTo(0.2853, 4);
    expect(math.erlangC(14, 10)).toBeCloseTo(0.1741, 4);
  });

  test("matches the published service level for 13 agents", () => {
    expect(math.serviceFor(13, load).serviceLevel).toBeCloseTo(79.6, 1);
  });

  test("needs 14 agents on shift and 20 after shrinkage", () => {
    const result = math.staffing(load);
    expect(result?.traffic).toBe(10);
    expect(result?.agents).toBe(14);
    expect(result?.scheduled).toBe(20);
    expect(result?.serviceLevel).toBeCloseTo(88.8, 1);
    expect(result?.averageWaitSeconds).toBeCloseTo(7.8, 1);
    expect(result?.occupancy).toBeCloseTo(71.4, 1);
  });

  test("counts each agent's chat slots when agents handle chats at once", () => {
    const one = math.staffing({ ...load, concurrency: 1 });
    const three = math.staffing({ ...load, concurrency: 3 });
    expect(three?.agents).toBe(Math.ceil((one?.agents ?? 0) / 3));
  });

  test("always waits when the load fills every slot", () => {
    expect(math.erlangC(10, 10)).toBe(1);
    expect(math.serviceFor(10, load).serviceLevel).toBe(0);
  });

  test("rejects inputs that make no sense", () => {
    expect(math.staffing({ ...load, perHour: 0 })).toBeNull();
    expect(math.staffing({ ...load, targetPercent: 100 })).toBeNull();
    expect(math.staffing({ ...load, shrinkagePercent: 100 })).toBeNull();
  });
});

describe("verdicts", () => {
  test("NPS compares with zero and the averages the page cites", () => {
    expect(math.npsVerdict(-5)).toMatchObject({ tone: "poor" });
    expect(math.npsVerdict(0).text).toBe("As many detractors as promoters.");
    expect(math.npsVerdict(41).text).toBe("More promoters than detractors. That's good.");
    expect(math.npsVerdict(45).text).toBe("Above the B2B SaaS average of 41.");
    expect(math.npsVerdict(70).text).toContain("ecommerce average of 61");
  });

  test("CSAT compares with the 79.9% live chat average", () => {
    expect(math.csatVerdict(85)).toMatchObject({ tone: "good" });
    expect(math.csatVerdict(79.9).text).toBe("Level with the 79.9% live chat average.");
    expect(math.csatVerdict(70).text).toMatch(/^Below the 79.9%/);
    expect(math.csatVerdict(40)).toMatchObject({ tone: "poor" });
  });

  test("AHT compares chat time, without wrap-up, with 8 min 25 s and 10 min 25 s", () => {
    expect(math.ahtVerdict(8).text).toContain("shorter");
    expect(math.ahtVerdict(9).text).toContain("about as long");
    expect(math.ahtVerdict(625 / 60).text).toContain("about as long");
    expect(math.ahtVerdict(11).text).toContain("longer");
  });

  test("uptime compares with what AWS and Google promise", () => {
    expect(math.uptimeVerdict(99.9).text).toBe(
      "What Google promises for one Compute Engine instance.",
    );
    expect(math.uptimeVerdict(99.95).text).toBe(
      "More than Google promises for one Compute Engine instance, 99.9%.",
    );
    expect(math.uptimeVerdict(99.999).text).toContain("AWS and Google promise");
    expect(math.uptimeVerdict(99).text).toBe("Less than AWS promises for one EC2 instance, 99.5%.");
  });
});

describe("SLA ladder", () => {
  test("a 45 minute outage in a month misses 99.9% by about a minute, as the page says", () => {
    const ladder = math.slaLadder(2700, "month");
    expect(ladder.map((rung) => rung.isMet)).toEqual([true, true, false, false, false, false]);
    expect(ladder[2]?.marginSeconds).toBeCloseTo(70.2, 6);
    expect(math.slaVerdict(2700, "month").text).toBe(
      "Meets a 99.5% SLA. Misses 99.9% by 1 min 10 s.",
    );
  });

  test("names the ends of the ladder", () => {
    expect(math.slaVerdict(0, "day").text).toBe("Meets even a 99.999% SLA.");
    expect(math.slaVerdict(86_400, "day")).toMatchObject({
      tone: "poor",
      text: "Misses a 99% SLA by 23 h 45 min 36 s.",
    });
  });
});

describe("durationParts", () => {
  test("splits a duration into values and units for the big number", () => {
    expect(math.durationParts(2629.8)).toEqual([
      ["43", "min"],
      ["50", "s"],
    ]);
    expect(math.durationParts(8.64)).toEqual([["8.6", "s"]]);
    expect(math.durationParts(Infinity)).toEqual([["never", ""]]);
  });
});

describe("scales", () => {
  test("the log scale runs from a tenth of a second to a year", () => {
    expect(math.logShare(0)).toBe(0);
    expect(math.logShare(0.1)).toBe(0);
    expect(math.logShare(31_557_600)).toBe(1);
    expect(math.logShare(1e9)).toBe(1);
    expect(math.logShare(60)).toBeGreaterThan(math.logShare(1));
  });

  test("an axis ends on a round number with at most four steps", () => {
    expect(math.axisFor(12)).toEqual({ end: 15, step: 5 });
    expect(math.axisFor(10)).toEqual({ end: 10, step: 5 });
    expect(math.axisFor(3)).toEqual({ end: 3, step: 1 });
    expect(math.axisFor(100)).toEqual({ end: 120, step: 30 });
  });
});

describe("parseQuery", () => {
  const fields: Record<string, "number" | string[]> = {
    promoters: "number",
    period: ["day", "month"],
  };

  test("reads numbers and known options", () => {
    expect(math.parseQuery("?promoters=60&period=month", fields)).toEqual({
      promoters: "60",
      period: "month",
    });
    expect(math.parseQuery("?promoters=99.95", { promoters: "number" })).toEqual({
      promoters: "99.95",
    });
  });

  test("drops unknown names, bad numbers and unknown options", () => {
    expect(math.parseQuery("?promoters=-3&period=decade&other=1", fields)).toEqual({});
    expect(math.parseQuery("?promoters=1e9", { promoters: "number" })).toEqual({});
    expect(math.parseQuery("?promoters=%3Cscript%3E", { promoters: "number" })).toEqual({});
  });
});
