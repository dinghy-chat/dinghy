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
interface ToolMath {
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
