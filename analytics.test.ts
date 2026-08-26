import { describe, expect, it } from "vitest";
import {
  aggregateAnalytics,
  concurrencyStats,
  crashRecoveryEnd,
  activityProfile,
  percentile,
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
});
