import { describe, expect, it } from "vitest";
import {
  aggregateAnalytics,
  concurrencyStats,
  crashRecoveryEnd,
  activityProfile,
  dayKey,
  dayKeyToUtc,
  percentile,
  rangeStart,
  shiftDayKey,
  weekdayOfDayKey,
  isValidTimeZone,
  normalizeTimeZone,
  unionIntervals,
  unionMs,
  type SessionInterval,
  type TurnInterval,
} from "./analytics.js";

const minute = 60_000;
const base = new Date(2026, 7, 20, 0, 0, 0, 0).getTime();

function session(start: number, end: number, projectName = "Alpha"): SessionInterval {
  return {
    id: start,
    start,
    end,
    projectName,
    machineName: "Studio",
    closureReason: "idle",
  };
}

function turn(start: number, end: number, model = "gpt-5"): TurnInterval {
  return {
    start,
    end,
    providerId: "codex",
    model,
    projectName: "Alpha",
    attributionQuality: "sampled-live",
    closureReason: "completed",
  };
}

describe("interval union and clipping", () => {
  it("clips, merges nested/touching intervals, and ignores invalid rows", () => {
    const rows = [
      { start: base - 10, end: base + 10 },
      { start: base + 5, end: base + 15 },
      { start: base + 15, end: base + 20 },
      { start: base + 7, end: base + 8 },
      { start: base + 30, end: base + 30 },
      { start: base + 50, end: base + 40 },
    ];
    expect(unionIntervals(rows, base, base + 40)).toEqual([
      { start: base, end: base + 20 },
    ]);
    expect(unionMs(rows, base, base + 40)).toBe(20);
  });

  it("keeps disjoint intervals separate", () => {
    expect(unionMs([
      { start: base, end: base + 5 },
      { start: base + 10, end: base + 20 },
    ], base, base + 100)).toBe(15);
  });
});

describe("concurrency", () => {
  it("distinguishes summed runtime, unioned coverage, peak, average, and swarm", () => {
    const result = concurrencyStats([
      { start: base, end: base + 10 * minute },
      { start: base, end: base + 10 * minute },
    ], base, base + 20 * minute);
    expect(result.agentRuntimeMs).toBe(20 * minute);
    expect(result.agentCoverageMs).toBe(10 * minute);
    expect(result.averageConcurrentTurns).toBe(2);
    expect(result.peakConcurrentTurns).toBe(2);
    expect(result.swarmTimeMs).toBe(10 * minute);
  });

  it("treats adjacent half-open intervals as concurrency one", () => {
    const result = concurrencyStats([
      { start: base, end: base + 10 * minute },
      { start: base + 10 * minute, end: base + 20 * minute },
    ], base, base + 20 * minute);
    expect(result.agentRuntimeMs).toBe(20 * minute);
    expect(result.agentCoverageMs).toBe(20 * minute);
    expect(result.peakConcurrentTurns).toBe(1);
    expect(result.swarmTimeMs).toBe(0);
  });
});

describe("aggregate analytics", () => {
  it("keeps parallel daily runtime summed while coverage and work are unioned", () => {
    const result = aggregateAnalytics(
      [session(base, base + 30 * minute), session(base + 5 * minute, base + 20 * minute)],
      [turn(base, base + 10 * minute), turn(base, base + 10 * minute)],
      base,
      base + 24 * 60 * minute,
    );
    expect(result.workingMs).toBe(30 * minute);
    expect(result.agentRuntimeMs).toBe(20 * minute);
    expect(result.agentCoverageMs).toBe(10 * minute);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]).toMatchObject({
      workingMs: 30 * minute,
      agentRuntimeMs: 20 * minute,
      agentCoverageMs: 10 * minute,
      peakConcurrentTurns: 2,
    });
  });

  it("computes coverage only inside working intervals and never makes runway negative", () => {
    const result = aggregateAnalytics(
      [session(base, base + 2 * 60 * minute)],
      [turn(base - 30 * minute, base + 30 * minute), turn(base + 90 * minute, base + 3 * 60 * minute)],
      base - 60 * minute,
      base + 4 * 60 * minute,
    );
    expect(result.coveredWorkingMs).toBe(60 * minute);
    expect(result.idleRunwayMs).toBe(60 * minute);
    expect(result.coveragePercent).toBe(50);
  });

  it("calculates duration distribution, pace, streak, and busiest day", () => {
    const nextDay = base + 24 * 60 * minute;
    const result = aggregateAnalytics(
      [session(base, base + 60 * minute), session(nextDay, nextDay + 2 * 60 * minute)],
      [turn(base, base + 10 * minute), turn(nextDay, nextDay + 30 * minute)],
      base,
      nextDay + 24 * 60 * minute,
    );
    expect(result.medianTurnMs).toBe(20 * minute);
    expect(result.p90TurnMs).toBe(30 * minute);
    expect(result.longestStreakDays).toBe(2);
    expect(result.busiestDay?.workingMs).toBe(2 * 60 * minute);
    expect(result.turnsPerActiveHour).toBeCloseTo(2 / 3);
  });
});

describe("recovery and percentiles", () => {
  it("bounds crash recovery by the persisted heartbeat instead of restart time", () => {
    const started = 1_000;
    expect(crashRecoveryEnd(started, 2_000, 100_000, 500)).toBe(2_500);
    expect(crashRecoveryEnd(started, 200_000, 100_000, 500)).toBe(100_000);
    expect(crashRecoveryEnd(started, null, 100_000, 500)).toBe(1_500);
    expect(crashRecoveryEnd(5_000, 1_000, 100_000, 500)).toBe(5_000);
  });

  it("uses a conventional median and nearest-rank p90", () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([10], 0.5)).toBe(10);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(50);
  });
});

describe("activity profile", () => {
  const hour = 60 * minute;

  it("splits a session across the local hours it actually occupied", () => {
    // 22:30 on Aug 20 through 01:30 on Aug 21
    const start = base + 22 * hour + 30 * minute;
    const profile = activityProfile([{ start, end: start + 3 * hour }], base, base + 2 * 24 * hour);

    expect(profile.hours[22]).toBe(30 * minute);
    expect(profile.hours[23]).toBe(hour);
    expect(profile.hours[0]).toBe(hour);
    expect(profile.hours[1]).toBe(30 * minute);
    expect(profile.hours.reduce((sum, value) => sum + value, 0)).toBe(3 * hour);
  });

  it("charges each side of midnight to its own weekday", () => {
    const start = base + 23 * hour;
    const profile = activityProfile([{ start, end: start + 2 * hour }], base, base + 2 * 24 * hour);

    // Aug 20 2026 is a Thursday, so the spillover lands on Friday
    expect(profile.weekdays[4]).toBe(hour);
    expect(profile.weekdays[5]).toBe(hour);
  });

  it("counts overlapping sessions once, like every other working-time figure", () => {
    const start = base + 9 * hour;
    const profile = activityProfile(
      [{ start, end: start + hour }, { start: start + 30 * minute, end: start + 90 * minute }],
      base,
      base + 24 * hour,
    );

    expect(profile.hours[9]).toBe(hour);
    expect(profile.hours[10]).toBe(30 * minute);
  });

  it("is empty when nothing overlaps the window", () => {
    const profile = activityProfile([], base, base + 24 * hour);
    expect(profile.hours).toHaveLength(24);
    expect(profile.weekdays).toHaveLength(7);
    expect(profile.hours.every((value) => value === 0)).toBe(true);
  });

  it("buckets an absolute timestamp in the requested viewer timezone", () => {
    const start = Date.parse("2026-08-20T09:30:00.000Z");
    const profile = activityProfile(
      [{ start, end: start + hour }],
      start,
      start + hour,
      "Asia/Kolkata",
    );

    expect(profile.hours[15]).toBe(hour);
    expect(profile.hours[9]).toBe(0);
  });

  it("handles skipped and repeated daylight-saving hours", () => {
    const springStart = Date.parse("2026-03-08T06:30:00.000Z");
    const spring = activityProfile(
      [{ start: springStart, end: springStart + hour }],
      springStart,
      springStart + hour,
      "America/New_York",
    );
    expect(spring.hours[1]).toBe(30 * minute);
    expect(spring.hours[2]).toBe(0);
    expect(spring.hours[3]).toBe(30 * minute);

    const fallStart = Date.parse("2026-11-01T05:30:00.000Z");
    const fall = activityProfile(
      [{ start: fallStart, end: fallStart + 2 * hour }],
      fallStart,
      fallStart + 2 * hour,
      "America/New_York",
    );
    expect(fall.hours[1]).toBe(90 * minute);
    expect(fall.hours[2]).toBe(30 * minute);
  });
});

describe("viewer timezone calendar boundaries", () => {
  it("starts today at midnight in the requested IANA timezone", () => {
    const now = Date.parse("2026-08-20T10:00:00.000Z");
    expect(rangeStart("today", now, undefined, "Asia/Kolkata"))
      .toBe(Date.parse("2026-08-19T18:30:00.000Z"));
    expect(dayKey(now, "Asia/Kolkata")).toBe("2026-08-20");
    expect(dayKey(now, "America/Los_Angeles")).toBe("2026-08-20");
  });

  it("splits daily totals at the viewer's midnight", () => {
    const start = Date.parse("2026-08-20T18:00:00.000Z");
    const end = Date.parse("2026-08-20T20:00:00.000Z");
    const result = aggregateAnalytics(
      [session(start, end)],
      [],
      start,
      end,
      "Asia/Kolkata",
    );

    expect(result.days.map((day) => [day.date, day.workingMs])).toEqual([
      ["2026-08-20", 30 * minute],
      ["2026-08-21", 90 * minute],
    ]);
  });
});

describe("calendar key arithmetic", () => {
  it("shifts across month, year and leap-day boundaries", () => {
    expect(shiftDayKey("2026-08-20", 1)).toBe("2026-08-21");
    expect(shiftDayKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDayKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDayKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDayKey("2026-08-20", 0)).toBe("2026-08-20");
  });

  it("reads weekdays with Sunday as zero", () => {
    expect(weekdayOfDayKey("2026-08-23")).toBe(0);
    expect(weekdayOfDayKey("2026-08-28")).toBe(5);
  });

  it("walks a trailing year of keys without duplicating or skipping a day", () => {
    // Regression: the heatmap grid used to step a local Date by 86_400_000 ms,
    // which drifts an hour at each DST transition. In a DST zone that rendered
    // one date twice, dropped another entirely, and pushed 18 weeks of cells
    // into the wrong weekday row.
    const end = shiftDayKey("2026-08-28", 6 - weekdayOfDayKey("2026-08-28"));
    const start = shiftDayKey(end, -(53 * 7 - 1));
    const keys = Array.from({ length: 53 * 7 }, (_, offset) => shiftDayKey(start, offset));

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe(start);
    expect(keys[keys.length - 1]).toBe(end);
    for (const [offset, key] of keys.entries()) {
      expect(weekdayOfDayKey(key)).toBe(offset % 7);
      expect(dayKeyToUtc(key) - dayKeyToUtc(start)).toBe(offset * 86_400_000);
    }
  });
});

describe("timezone edge cases", () => {
  const hour = 60 * minute;

  it("starts a day whose local midnight never happens", () => {
    // Santiago springs forward at 00:00 on 2026-09-06, so that date's first
    // representable wall time is 01:00.
    const start = rangeStart("today", Date.parse("2026-09-06T18:00:00.000Z"), undefined, "America/Santiago");
    expect(new Date(start).toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(dayKey(start, "America/Santiago")).toBe("2026-09-06");
    expect(dayKey(start - 1, "America/Santiago")).toBe("2026-09-05");
  });

  it("keeps short and long DST days whole", () => {
    const day = (date: string, zone: string) =>
      rangeStart("today", dayKeyToUtc(date) + 12 * 3_600_000, undefined, zone);
    // 23 hours forward, 25 hours back, in the same zone.
    expect(day("2026-03-09", "America/New_York") - day("2026-03-08", "America/New_York"))
      .toBe(23 * 3_600_000);
    expect(day("2026-11-02", "America/New_York") - day("2026-11-01", "America/New_York"))
      .toBe(25 * 3_600_000);
    // A half-hour DST shift, which whole-hour arithmetic would round away.
    expect(day("2026-10-05", "Australia/Lord_Howe") - day("2026-10-04", "Australia/Lord_Howe"))
      .toBe(23.5 * 3_600_000);
  });

  it("charges a DST day the full wall-clock time it covers", () => {
    // 2026-11-01 in New York is 25 hours long; a session spanning it entirely
    // must report 25 hours of working time on that date.
    const start = rangeStart("today", Date.parse("2026-11-01T12:00:00.000Z"), undefined, "America/New_York");
    const end = start + 25 * hour;
    const result = aggregateAnalytics([session(start, end)], [], start, end, "America/New_York");

    expect(result.days).toHaveLength(1);
    expect(result.days[0]!.date).toBe("2026-11-01");
    expect(result.days[0]!.workingMs).toBe(25 * hour);
    expect(result.profile.hours.reduce((total, value) => total + value, 0)).toBe(25 * hour);
    expect(result.profile.weekdays[0]).toBe(25 * hour);
  });

  it("falls back to the system zone for missing or unusable timezones", () => {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(normalizeTimeZone(undefined)).toBe(system);
    expect(normalizeTimeZone("Not/AZone")).toBe(system);
    expect(normalizeTimeZone("")).toBe(system);
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("keeps day boundaries independent of the process timezone", () => {
    const now = Date.parse("2026-08-20T10:00:00.000Z");
    for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(dayKey(rangeStart("today", now, undefined, zone), zone)).toBe(dayKey(now, zone));
      expect(rangeStart("7d", now, undefined, zone))
        .toBeLessThan(rangeStart("today", now, undefined, zone));
    }
    // Zones far enough apart to disagree about which date it is.
    expect(dayKey(now, "Pacific/Kiritimati")).toBe("2026-08-21");
    expect(dayKey(now, "Pacific/Midway")).toBe("2026-08-19");
  });
});
