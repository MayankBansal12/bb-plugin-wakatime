export type RangeKey = "today" | "7d" | "30d" | "all";

export interface Interval {
  start: number;
  end: number;
}

export interface SessionInterval extends Interval {
  id: number;
  projectName: string | null;
  machineName: string | null;
  closureReason: string;
}

export interface TurnInterval extends Interval {
  providerId: string;
  model: string;
  projectName: string | null;
  attributionQuality: string;
  closureReason: string;
}

export interface DailyActivity {
  date: string;
  workingMs: number;
  agentRuntimeMs: number;
  agentCoverageMs: number;
  turnCount: number;
  peakConcurrentTurns: number;
}

const DAY_MS = 86_400_000;

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function rangeStart(
  range: RangeKey,
  now: number,
  earliestTimestamp?: number,
): number {
  const today = localDayStart(now);
  if (range === "today") return today;
  if (range === "7d") return addLocalDays(today, -6);
  if (range === "30d") return addLocalDays(today, -29);
  return Math.min(today, earliestTimestamp ?? today);
}

export function clipInterval(
  interval: Interval,
  from: number,
  to: number,
): Interval | null {
  const start = Math.max(interval.start, from);
  const end = Math.min(interval.end, to);
  return end > start ? { start, end } : null;
}

export function unionIntervals(
  intervals: readonly Interval[],
  from: number,
  to: number,
): Interval[] {
  const clipped = intervals
    .map((interval) => clipInterval(interval, from, to))
    .filter((interval): interval is Interval => interval !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const result: Interval[] = [];
  for (const interval of clipped) {
    const previous = result.at(-1);
    if (!previous || interval.start > previous.end) {
      result.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return result;
}

export function unionMs(
  intervals: readonly Interval[],
  from: number,
  to: number,
): number {
  return unionIntervals(intervals, from, to).reduce(
    (total, interval) => total + interval.end - interval.start,
    0,
  );
}

export function intersectionMs(
  left: readonly Interval[],
  right: readonly Interval[],
  from: number,
  to: number,
): number {
  const a = unionIntervals(left, from, to);
  const b = unionIntervals(right, from, to);
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) total += end - start;
    if (a[i]!.end <= b[j]!.end) i += 1;
    else j += 1;
  }
  return total;
}

export function longestUncoveredMs(
  working: readonly Interval[],
  covered: readonly Interval[],
  from: number,
  to: number,
): number {
  const work = unionIntervals(working, from, to);
  const cover = unionIntervals(covered, from, to);
  let longest = 0;
  let coverIndex = 0;
  for (const interval of work) {
    let cursor = interval.start;
    while (coverIndex < cover.length && cover[coverIndex]!.end <= interval.start) {
      coverIndex += 1;
    }
    let i = coverIndex;
    while (i < cover.length && cover[i]!.start < interval.end) {
      const overlap = cover[i]!;
      if (overlap.start > cursor) longest = Math.max(longest, overlap.start - cursor);
      cursor = Math.max(cursor, Math.min(interval.end, overlap.end));
      if (cursor >= interval.end) break;
      i += 1;
    }
    longest = Math.max(longest, interval.end - cursor);
  }
  return longest;
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentileValue === 0.5 && sorted.length % 2 === 0) {
    const high = sorted.length / 2;
    return (sorted[high - 1]! + sorted[high]!) / 2;
  }
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

export interface ConcurrencyStats {
  agentRuntimeMs: number;
  agentCoverageMs: number;
  averageConcurrentTurns: number;
  peakConcurrentTurns: number;
  swarmTimeMs: number;
  distribution: { concurrentTurns: number; durationMs: number }[];
}

export function concurrencyStats(
  intervals: readonly Interval[],
  from: number,
  to: number,
): ConcurrencyStats {
  const events = new Map<number, number>();
  let agentRuntimeMs = 0;
  for (const interval of intervals) {
    const clipped = clipInterval(interval, from, to);
    if (!clipped) continue;
    agentRuntimeMs += clipped.end - clipped.start;
    events.set(clipped.start, (events.get(clipped.start) ?? 0) + 1);
    events.set(clipped.end, (events.get(clipped.end) ?? 0) - 1);
  }

  const distribution = new Map<number, number>();
  let concurrent = 0;
  let previous: number | null = null;
  let peakConcurrentTurns = 0;
  for (const [at, delta] of [...events.entries()].sort((a, b) => a[0] - b[0])) {
    if (previous !== null && at > previous && concurrent > 0) {
      distribution.set(
        concurrent,
        (distribution.get(concurrent) ?? 0) + at - previous,
      );
    }
    concurrent += delta;
    peakConcurrentTurns = Math.max(peakConcurrentTurns, concurrent);
    previous = at;
  }

  const rows = [...distribution.entries()]
    .map(([concurrentTurns, durationMs]) => ({ concurrentTurns, durationMs }))
    .sort((a, b) => a.concurrentTurns - b.concurrentTurns);
  const agentCoverageMs = rows.reduce((total, row) => total + row.durationMs, 0);
  const swarmTimeMs = rows
    .filter((row) => row.concurrentTurns >= 2)
    .reduce((total, row) => total + row.durationMs, 0);

  return {
    agentRuntimeMs,
    agentCoverageMs,
    averageConcurrentTurns:
      agentCoverageMs > 0 ? agentRuntimeMs / agentCoverageMs : 0,
    peakConcurrentTurns,
    swarmTimeMs,
    distribution: rows,
  };
}

function splitAcrossDays(interval: Interval): { date: string; interval: Interval }[] {
  const segments: { date: string; interval: Interval }[] = [];
  let cursor = interval.start;
  while (cursor < interval.end) {
    const nextDay = addLocalDays(localDayStart(cursor), 1);
    const end = Math.min(interval.end, nextDay);
    segments.push({ date: dayKey(cursor), interval: { start: cursor, end } });
    cursor = end;
  }
  return segments;
}

function enumerateDays(from: number, to: number): string[] {
  const dates: string[] = [];
  let cursor = localDayStart(from);
  while (cursor < to) {
    dates.push(dayKey(cursor));
    cursor = addLocalDays(cursor, 1);
  }
  return dates;
}

function dimensionBreakdown<T extends Interval>(
  intervals: readonly T[],
  from: number,
  to: number,
  getName: (interval: T) => string | null,
): { name: string; workingMs: number }[] {
  const groups = new Map<string, Interval[]>();
  for (const interval of intervals) {
    const name = getName(interval) || "Unknown";
    const rows = groups.get(name) ?? [];
    rows.push(interval);
    groups.set(name, rows);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({ name, workingMs: unionMs(rows, from, to) }))
    .filter((row) => row.workingMs > 0)
    .sort((a, b) => b.workingMs - a.workingMs || a.name.localeCompare(b.name));
}

function streaks(days: readonly DailyActivity[], today: string) {
  let longestStreakDays = 0;
  let run = 0;
  for (const day of days) {
    if (day.workingMs > 0) {
      run += 1;
      longestStreakDays = Math.max(longestStreakDays, run);
    } else {
      run = 0;
    }
  }

  let currentStreakDays = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const day = days[i]!;
    if (day.date === today && day.workingMs === 0) continue;
    if (day.workingMs === 0) break;
    currentStreakDays += 1;
  }
  return { currentStreakDays, longestStreakDays };
}

export function aggregateAnalytics(
  sessions: readonly SessionInterval[],
  turns: readonly TurnInterval[],
  from: number,
  to: number,
) {
  const sessionIntervals: readonly Interval[] = sessions;
  const turnIntervals: readonly Interval[] = turns;
  const workingMs = unionMs(sessionIntervals, from, to);
  const concurrency = concurrencyStats(turnIntervals, from, to);
  const coveredWorkingMs = intersectionMs(sessionIntervals, turnIntervals, from, to);
  const idleRunwayMs = Math.max(0, workingMs - coveredWorkingMs);

  const workingDays = new Map<string, Interval[]>();
  const turnDays = new Map<string, TurnInterval[]>();
  for (const session of sessions) {
    const clipped = clipInterval(session, from, to);
    if (!clipped) continue;
    for (const segment of splitAcrossDays(clipped)) {
      const rows = workingDays.get(segment.date) ?? [];
      rows.push(segment.interval);
      workingDays.set(segment.date, rows);
    }
  }
  for (const turn of turns) {
    const clipped = clipInterval(turn, from, to);
    if (!clipped) continue;
    for (const segment of splitAcrossDays(clipped)) {
      const rows = turnDays.get(segment.date) ?? [];
      rows.push({ ...turn, ...segment.interval });
      turnDays.set(segment.date, rows);
    }
  }

  const days = enumerateDays(from, to).map((date): DailyActivity => {
    const dailyWorking = workingDays.get(date) ?? [];
    const dailyTurns = turnDays.get(date) ?? [];
    const dayFrom = dailyWorking[0]?.start ?? dailyTurns[0]?.start ?? from;
    const dayStart = localDayStart(dayFrom);
    const dayEnd = addLocalDays(dayStart, 1);
    const dailyConcurrency = concurrencyStats(dailyTurns, dayStart, dayEnd);
    return {
      date,
      workingMs: unionMs(dailyWorking, dayStart, dayEnd),
      agentRuntimeMs: dailyConcurrency.agentRuntimeMs,
      agentCoverageMs: dailyConcurrency.agentCoverageMs,
      turnCount: dailyTurns.length,
      peakConcurrentTurns: dailyConcurrency.peakConcurrentTurns,
    };
  });

  const models = new Map<
    string,
    {
      providerId: string;
      model: string;
      agentRuntimeMs: number;
      turnCount: number;
      observedTurnCount: number;
    }
  >();
  const projectModels = new Map<
    string,
    { projectName: string; providerId: string; model: string; agentRuntimeMs: number; turnCount: number }
  >();
  const durations: number[] = [];
  for (const turn of turns) {
    const clipped = clipInterval(turn, from, to);
    if (!clipped) continue;
    const duration = clipped.end - clipped.start;
    durations.push(duration);
    const providerId = turn.providerId || "Unknown";
    const model = turn.model || "Unknown";
    const key = `${providerId}\u0000${model}`;
    const modelRow = models.get(key) ?? {
      providerId,
      model,
      agentRuntimeMs: 0,
      turnCount: 0,
      observedTurnCount: 0,
    };
    modelRow.agentRuntimeMs += duration;
    modelRow.turnCount += 1;
    if (turn.attributionQuality === "sampled-live") modelRow.observedTurnCount += 1;
    models.set(key, modelRow);

    if (
      turn.projectName &&
      turn.attributionQuality === "sampled-live" &&
      providerId !== "Unknown" &&
      model !== "unknown" &&
      model !== "Unknown"
    ) {
      const projectKey = `${turn.projectName}\u0000${key}`;
      const projectRow = projectModels.get(projectKey) ?? {
        projectName: turn.projectName,
        providerId,
        model,
        agentRuntimeMs: 0,
        turnCount: 0,
      };
      projectRow.agentRuntimeMs += duration;
      projectRow.turnCount += 1;
      projectModels.set(projectKey, projectRow);
    }
  }

  const busiestDay = days.reduce<DailyActivity | null>(
    (best, day) => (!best || day.workingMs > best.workingMs ? day : best),
    null,
  );
  const { currentStreakDays, longestStreakDays } = streaks(days, dayKey(to));
  const clippedTurns = turns.filter((turn) => clipInterval(turn, from, to));

  return {
    workingMs,
    coveredWorkingMs,
    coveragePercent: workingMs > 0 ? (coveredWorkingMs / workingMs) * 100 : 0,
    idleRunwayMs,
    longestIdleRunwayMs: longestUncoveredMs(sessionIntervals, turnIntervals, from, to),
    turnCount: clippedTurns.length,
    medianTurnMs: percentile(durations, 0.5),
    p90TurnMs: percentile(durations, 0.9),
    turnsPerActiveHour: workingMs > 0 ? clippedTurns.length / (workingMs / 3_600_000) : 0,
    ...concurrency,
    days,
    projects: dimensionBreakdown(sessions, from, to, (session) => session.projectName),
    machines: dimensionBreakdown(sessions, from, to, (session) => session.machineName),
    models: [...models.values()].sort(
      (a, b) => b.agentRuntimeMs - a.agentRuntimeMs || a.model.localeCompare(b.model),
    ),
    projectModels: [...projectModels.values()].sort(
      (a, b) => b.agentRuntimeMs - a.agentRuntimeMs || a.projectName.localeCompare(b.projectName),
    ),
    currentStreakDays,
    longestStreakDays,
    busiestDay: busiestDay && busiestDay.workingMs > 0
      ? { date: busiestDay.date, workingMs: busiestDay.workingMs }
      : null,
    quality: {
      sessionCount: sessions.filter((session) => clipInterval(session, from, to)).length,
      openSessionCount: sessions.filter(
        (session) => session.closureReason === "open" && clipInterval(session, from, to),
      ).length,
      recoveredSessionCount: sessions.filter(
        (session) => session.closureReason === "crash-recovery" && clipInterval(session, from, to),
      ).length,
      observedTurnCount: clippedTurns.filter(
        (turn) => turn.attributionQuality === "sampled-live",
      ).length,
      recoveredTurnCount: clippedTurns.filter(
        (turn) => turn.closureReason === "crash-recovery",
      ).length,
      unknownModelTurnCount: clippedTurns.filter(
        (turn) => !turn.model || turn.model.toLowerCase() === "unknown",
      ).length,
      reliableProjectModelTurnCount: [...projectModels.values()].reduce(
        (total, row) => total + row.turnCount,
        0,
      ),
    },
  };
}

export function crashRecoveryEnd(
  sessionStart: number,
  lastHeartbeat: number | null,
  now: number,
  graceMs: number,
): number {
  const heartbeat =
    lastHeartbeat !== null && Number.isFinite(lastHeartbeat)
      ? lastHeartbeat
      : sessionStart;
  return Math.max(sessionStart, Math.min(now, heartbeat + graceMs));
}

export { DAY_MS };
