const DAY = 86_400_000;

function seeded(n: number) {
  // deterministic pseudo-random so screenshots are stable
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}

export function makeSummary(range: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const span = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 400;

  const days = Array.from({ length: span }, (_, i) => {
    const ts = today.getTime() - (span - 1 - i) * DAY;
    const r = seeded(i + 1);
    const weekend = [0, 6].includes(new Date(ts).getDay());
    // leave a realistic scatter of zero days so the heatmap has empties
    const idle = r < (weekend ? 0.55 : 0.18) || (range === "all" && i < span - 150);
    const workingMs = idle ? 0 : Math.round((0.6 + r * 5.5) * 3_600_000);
    return {
      date: dayKey(ts),
      workingMs,
      agentRuntimeMs: Math.round(workingMs * (0.8 + r * 0.9)),
      agentCoverageMs: Math.round(workingMs * 0.7),
      activeMs: workingMs, computeMs: workingMs, coverageMs: workingMs,
      turnCount: idle ? 0 : Math.round(8 + r * 60),
      peakConcurrentTurns: idle ? 0 : 1 + Math.round(r * 4),
    };
  });

  const workingMs = days.reduce((s, d) => s + d.workingMs, 0);
  const agentRuntimeMs = days.reduce((s, d) => s + d.agentRuntimeMs, 0);
  const turnCount = days.reduce((s, d) => s + d.turnCount, 0);
  const busiest = days.reduce((a, b) => (b.workingMs > a.workingMs ? b : a), days[0]);

  return {
    range: { key: range, from: today.getTime() - span * DAY, to: today.getTime(), timezone: "Asia/Kolkata" },
    generatedAt: Date.now(),
    workingMs, agentRuntimeMs, agentCoverageMs: Math.round(workingMs * 0.72),
    totalActiveMs: workingMs, totalComputeMs: agentRuntimeMs, turnCount,
    days,
    projects: [
      { name: "bb-plugin-wakatime", workingMs: Math.round(workingMs * 0.34), activeMs: 0 },
      { name: "sage", workingMs: Math.round(workingMs * 0.26), activeMs: 0 },
      { name: "creator-discovery", workingMs: Math.round(workingMs * 0.18), activeMs: 0 },
      { name: "linux-buddy", workingMs: Math.round(workingMs * 0.13), activeMs: 0 },
      { name: "mayank.fyi", workingMs: Math.round(workingMs * 0.09), activeMs: 0 },
    ],
    machines: [
      { name: "echio-staging", workingMs: Math.round(workingMs * 0.62), activeMs: 0 },
      { name: "afdasf", workingMs: Math.round(workingMs * 0.28), activeMs: 0 },
      { name: "fedora", workingMs: Math.round(workingMs * 0.10), activeMs: 0 },
    ],
    models: [
      { providerId: "codex", model: "gpt-5-codex", agentRuntimeMs: Math.round(agentRuntimeMs * 0.42), computeMs: 0, turnCount: Math.round(turnCount * 0.4), sampledTurnCount: 10 },
      { providerId: "claude-code", model: "anthropic/claude-opus-5", agentRuntimeMs: Math.round(agentRuntimeMs * 0.31), computeMs: 0, turnCount: Math.round(turnCount * 0.3), sampledTurnCount: 10 },
      { providerId: "claude-code", model: "anthropic/claude-sonnet-5", agentRuntimeMs: Math.round(agentRuntimeMs * 0.15), computeMs: 0, turnCount: Math.round(turnCount * 0.2), sampledTurnCount: 10 },
      { providerId: "pi", model: "pi-fast", agentRuntimeMs: Math.round(agentRuntimeMs * 0.12), computeMs: 0, turnCount: Math.round(turnCount * 0.1), sampledTurnCount: 10 },
    ],
    projectModels: [],
    concurrency: {
      averageConcurrentTurns: 1.8, peakConcurrentTurns: 6,
      swarmTimeMs: Math.round(workingMs * 0.31),
      distribution: [
        { concurrentTurns: 1, durationMs: Math.round(workingMs * 0.52) },
        { concurrentTurns: 2, durationMs: Math.round(workingMs * 0.24) },
        { concurrentTurns: 3, durationMs: Math.round(workingMs * 0.13) },
        { concurrentTurns: 4, durationMs: Math.round(workingMs * 0.07) },
        { concurrentTurns: 6, durationMs: Math.round(workingMs * 0.04) },
      ],
    },
    // a plausible night-owl curve: quiet mornings, an afternoon ramp, a late peak
    profile: {
      hours: Array.from({ length: 24 }, (_, h) => {
        const shape = [.02,.01,0,0,0,0,.01,.05,.18,.35,.5,.62,.55,.7,.85,.92,.8,.6,.45,.55,.78,1,.9,.4][h];
        return Math.round(workingMs * shape * 0.13 * (0.85 + seeded(h + 40) * 0.3));
      }),
      weekdays: Array.from({ length: 7 }, (_, d) => {
        const shape = [.35, .9, 1, .95, .85, .7, .3][d];
        return Math.round(workingMs * shape * 0.2);
      }),
    },
    previous: range === "all" ? null : {
      workingMs: Math.round(workingMs * 0.79),
      agentRuntimeMs: Math.round(agentRuntimeMs * 0.84),
      turnCount: Math.round(turnCount * 0.88),
    },
    pace: {
      coveredWorkingMs: Math.round(workingMs * 0.72), coveragePercent: 72,
      idleRunwayMs: Math.round(workingMs * 0.28), longestIdleRunwayMs: 41 * 60_000,
      medianTurnMs: 47_000, p90TurnMs: 236_000, turnsPerActiveHour: 9.4,
    },
    streak: {
      currentDays: 12, longestDays: 23,
      busiestDay: { date: busiest.date, workingMs: busiest.workingMs },
    },
    quality: {
      sessionCount: 184, openSessionCount: 3, recoveredSessionCount: 2,
      sampledTurnCount: Math.round(turnCount * 0.93), recoveredTurnCount: 4,
      unknownModelTurnCount: 12, linkedProjectModelTurnCount: 90,
    },
  };
}
