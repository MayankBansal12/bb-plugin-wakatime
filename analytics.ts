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
const HOUR_MS = 3_600_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Validate an IANA timezone, falling back only for trusted internal callers. */
export function normalizeTimeZone(timeZone?: string): string {
  const fallback = systemTimeZone();
  if (!timeZone) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return fallback;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, value);
  return value;
}

function zonedParts(timestamp: number, timeZone: string): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdays[values.weekday ?? ""] ?? 0,
  };
}

function keyFromParts(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** The UTC instant naming a `YYYY-MM-DD` key. Only for calendar arithmetic on
 *  the key itself — it is not the instant that day starts in any zone. */
export function dayKeyToUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

/** Shift a `YYYY-MM-DD` key by whole calendar days. Done in UTC so it is exact:
 *  stepping a local `Date` by 86_400_000 ms drifts across a DST transition. */
export function shiftDayKey(date: string, days: number): string {
  const shifted = new Date(dayKeyToUtc(date) + days * DAY_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Weekday of a `YYYY-MM-DD` key, 0 = Sunday, read in UTC for the same reason. */
export function weekdayOfDayKey(date: string): number {
  return new Date(dayKeyToUtc(date)).getUTCDay();
}

function offsetAt(timestamp: number, timeZone: string): number {
  const parts = zonedParts(timestamp, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  return representedAsUtc - Math.floor(timestamp / 1000) * 1000;
}

/** Resolve the first instant belonging to a local calendar date in an IANA zone. */
function dayStartForKey(date: string, timeZone: string): number {
  const cacheKey = `${timeZone}\u0000${date}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wallMidnight = Date.UTC(year, month - 1, day);
  let result = wallMidnight - offsetAt(wallMidnight, timeZone);
  result = wallMidnight - offsetAt(result, timeZone);

  const parts = zonedParts(result, timeZone);
  if (keyFromParts(parts) !== date || parts.hour !== 0 || parts.minute !== 0 || parts.second !== 0) {
    // Covers midnight offset changes and the rare calendar day whose first
    // representable wall time is later than 00:00.
    let low = wallMidnight - 36 * HOUR_MS;
    let high = wallMidnight + 36 * HOUR_MS;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (dayKey(middle, timeZone) < date) low = middle;
      else high = middle;
    }
    result = high;
  }

  dayStartCache.set(cacheKey, result);
  return result;
}

function localDayStart(timestamp: number, timeZone: string): number {
  return dayStartForKey(dayKey(timestamp, timeZone), timeZone);
}

function addLocalDays(timestamp: number, days: number, timeZone: string): number {
  return dayStartForKey(shiftDayKey(dayKey(timestamp, timeZone), days), timeZone);
}

export function dayKey(timestamp: number, timeZone = systemTimeZone()): string {
  return keyFromParts(zonedParts(timestamp, timeZone));
}

export function rangeStart(
  range: RangeKey,
  now: number,
  earliestTimestamp?: number,
  timeZone = systemTimeZone(),
): number {
  const today = localDayStart(now, timeZone);
  if (range === "today") return today;
  if (range === "7d") return addLocalDays(today, -6, timeZone);
  if (range === "30d") return addLocalDays(today, -29, timeZone);
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

export interface ActivityProfile {
  /** Working ms per local hour of day, index 0..23. */
  hours: number[];
  /** Working ms per local weekday, index 0 = Sunday .. 6 = Saturday. */
  weekdays: number[];
}

/**
 * Spreads unioned working time over local hour-of-day and weekday buckets.
 * Intervals are walked one local hour at a time so a session crossing midnight
 * lands its minutes in the buckets it actually occupied. The `hourEnd > cursor`
 * guard keeps a DST repeat hour from stalling the walk.
 */
export function activityProfile(
  intervals: readonly Interval[],
  from: number,
  to: number,
  timeZone = systemTimeZone(),
): ActivityProfile {
  const hours = Array.from({ length: 24 }, () => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);
  for (const interval of unionIntervals(intervals, from, to)) {
    let cursor = interval.start;
    while (cursor < interval.end) {
      const at = zonedParts(cursor, timeZone);
      const bucket = `${keyFromParts(at)}T${at.hour}`;
      const milliseconds = ((cursor % 1000) + 1000) % 1000;
      const untilNominalHour = HOUR_MS - at.minute * 60_000 - at.second * 1000 - milliseconds;
      let high = Math.min(interval.end, cursor + Math.max(1, untilNominalHour));
      const sameBucket = (timestamp: number) => {
        const parts = zonedParts(timestamp, timeZone);
        return `${keyFromParts(parts)}T${parts.hour}` === bucket;
      };

      // A repeated DST hour can still be the same bucket at the nominal
      // boundary. Advance by real hours until the wall-clock bucket changes.
      while (high < interval.end && sameBucket(high)) {
        high = Math.min(interval.end, high + HOUR_MS);
      }

      let end = high;
      if (!sameBucket(high) && high - cursor > 1 && !sameBucket(high - 1)) {
        // An offset transition may change the wall clock before the nominal
        // hour. Find that exact boundary without assuming a fixed UTC offset.
        let low = cursor;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (sameBucket(middle)) low = middle;
          else high = middle;
        }
        end = high;
      }

      hours[at.hour]! += end - cursor;
      weekdays[at.weekday]! += end - cursor;
      cursor = end;
    }
  }
  return { hours, weekdays };
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

function splitAcrossDays(interval: Interval, timeZone: string): { date: string; interval: Interval }[] {
  const segments: { date: string; interval: Interval }[] = [];
  let cursor = interval.start;
  while (cursor < interval.end) {
    const nextDay = addLocalDays(localDayStart(cursor, timeZone), 1, timeZone);
    const end = Math.min(interval.end, nextDay);
    segments.push({ date: dayKey(cursor, timeZone), interval: { start: cursor, end } });
    cursor = end;
  }
  return segments;
}

function enumerateDays(from: number, to: number, timeZone: string): string[] {
  const dates: string[] = [];
  let date = dayKey(from, timeZone);
  while (dayStartForKey(date, timeZone) < to) {
    dates.push(date);
    date = shiftDayKey(date, 1);
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
  timeZone = systemTimeZone(),
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
    for (const segment of splitAcrossDays(clipped, timeZone)) {
      const rows = workingDays.get(segment.date) ?? [];
      rows.push(segment.interval);
      workingDays.set(segment.date, rows);
    }
  }
  for (const turn of turns) {
    const clipped = clipInterval(turn, from, to);
    if (!clipped) continue;
    for (const segment of splitAcrossDays(clipped, timeZone)) {
      const rows = turnDays.get(segment.date) ?? [];
      rows.push({ ...turn, ...segment.interval });
      turnDays.set(segment.date, rows);
    }
  }

  const days = enumerateDays(from, to, timeZone).map((date): DailyActivity => {
    const dailyWorking = workingDays.get(date) ?? [];
    const dailyTurns = turnDays.get(date) ?? [];
    const dayStart = dayStartForKey(date, timeZone);
    const dayEnd = dayStartForKey(shiftDayKey(date, 1), timeZone);
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
  const { currentStreakDays, longestStreakDays } = streaks(days, dayKey(to, timeZone));
  const clippedTurns = turns.filter((turn) => clipInterval(turn, from, to));

  return {
    workingMs,
    profile: activityProfile(sessionIntervals, from, to, timeZone),
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
