import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { rpcContract } from "./server";
import { EvilAreaChart } from "@/components/evilcharts/charts/recharts-area-chart";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { cn } from "@/lib/utils";

type RangeKey = "today" | "7d" | "30d" | "all";

type Breakdown = { name: string; workingMs: number; activeMs: number };

type Summary = {
  range: { key: RangeKey; from: number; to: number; timezone: string };
  generatedAt: number;
  workingMs: number;
  agentRuntimeMs: number;
  agentCoverageMs: number;
  totalActiveMs: number;
  totalComputeMs: number;
  turnCount: number;
  days: Array<{
    date: string; workingMs: number; agentRuntimeMs: number; agentCoverageMs: number;
    activeMs: number; computeMs: number; coverageMs: number;
    turnCount: number; peakConcurrentTurns: number;
  }>;
  projects: Breakdown[];
  machines: Breakdown[];
  models: Array<{
    providerId: string; model: string; agentRuntimeMs: number;
    computeMs: number; turnCount: number; sampledTurnCount: number;
  }>;
  projectModels: Array<{
    projectName: string; providerId: string; model: string;
    agentRuntimeMs: number; turnCount: number;
  }>;
  concurrency: {
    averageConcurrentTurns: number; peakConcurrentTurns: number; swarmTimeMs: number;
    distribution: Array<{ concurrentTurns: number; durationMs: number }>;
  };
  pace: {
    coveredWorkingMs: number; coveragePercent: number; idleRunwayMs: number;
    longestIdleRunwayMs: number; medianTurnMs: number; p90TurnMs: number;
    turnsPerActiveHour: number;
  };
  streak: {
    currentDays: number; longestDays: number;
    busiestDay: { date: string; workingMs: number } | null;
  };
  quality: {
    sessionCount: number; openSessionCount: number; recoveredSessionCount: number;
    sampledTurnCount: number; recoveredTurnCount: number; unknownModelTurnCount: number;
    linkedProjectModelTurnCount: number;
  };
};

const RANGES: Array<{ key: RangeKey; label: string; blurb: string }> = [
  { key: "today", label: "Today", blurb: "today" },
  { key: "7d", label: "7 days", blurb: "this week" },
  { key: "30d", label: "30 days", blurb: "this month" },
  { key: "all", label: "All time", blurb: "all time" },
];

// Categorical slots 1 and 3 of the validated palette, stepped per mode.
// Chrome (grid, axes, text) stays on host theme tokens.
const SERIES = {
  working: { light: "#2a78d6", dark: "#3987e5" },
  agent: { light: "#1baf7a", dark: "#199e70" },
} as const;

const activityConfig = {
  working: { label: "Working", colors: { light: [SERIES.working.light], dark: [SERIES.working.dark] } },
  agent: { label: "Agent time", colors: { light: [SERIES.agent.light], dark: [SERIES.agent.dark] } },
} satisfies ChartConfig;

const singleConfig = {
  value: { label: "Time", colors: { light: [SERIES.working.light], dark: [SERIES.working.dark] } },
} satisfies ChartConfig;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function splitDuration(ms: number): Array<{ value: string; unit: string }> {
  if (!Number.isFinite(ms) || ms <= 0) return [{ value: "0", unit: "m" }];
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return [{ value: String(Math.max(1, minutes)), unit: "m" }];
  const parts = [{ value: String(hours), unit: "h" }];
  if (rest > 0) parts.push({ value: String(rest), unit: "m" });
  return parts;
}

function formatDate(date: string, short = true): string {
  const value = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, short
    ? { month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" }).format(value);
}

function toMs(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function detailOf(item: unknown): string {
  if (typeof item !== "object" || item === null || !("payload" in item)) return "";
  const payload = (item as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null || !("detail" in payload)) return "";
  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : "";
}

function shortModel(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function providerLabel(providerId: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    pi: "Pi",
    acp: "ACP",
  };
  return known[providerId] ?? providerId;
}

function Card({ title, hint, action, children, className }: {
  title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn("bg-card border-border flex min-w-0 flex-col rounded-xl border p-4", className)}>
      {title ? (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-foreground text-sm font-medium">{title}</h2>
          {action ?? (hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null)}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function Stat({ label, value, unit, detail, accent }: {
  label: string; value: string; unit?: string; detail?: string; accent?: boolean;
}) {
  return (
    <div className="bg-card border-border flex min-w-0 flex-col gap-1 rounded-xl border p-4">
      <span className="text-muted-foreground truncate text-xs">{label}</span>
      <span className={cn(
        "text-foreground truncate text-2xl font-semibold tracking-tight tabular-nums",
        accent && "text-foreground",
      )}>
        {value}
        {unit ? <span className="text-muted-foreground ml-0.5 text-base font-normal">{unit}</span> : null}
      </span>
      {detail ? <span className="text-muted-foreground truncate text-xs">{detail}</span> : null}
    </div>
  );
}

function EmptyPlot({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-32 items-center justify-center text-center text-xs">
      {children}
    </div>
  );
}

function RankedBars({ rows, height, emptyLabel }: {
  rows: Array<{ name: string; value: number; detail?: string }>;
  height: number;
  emptyLabel: string;
}) {
  if (rows.length === 0) return <EmptyPlot>{emptyLabel}</EmptyPlot>;
  const data = rows.map((row) => ({ name: row.name, value: row.value, detail: row.detail ?? "" }));
  return (
    <div style={{ height }} className="w-full">
    <EvilBarChart
      data={data}
      config={singleConfig}
      layout="horizontal"
      barRadius={4}
      className="aspect-auto h-full w-full"
      xDataKey="name"
    >
      <EvilBarChart.XAxis type="number" dataKey="value" hide />
      <EvilBarChart.YAxis
        type="category"
        dataKey="name"
        width={112}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        tickFormatter={(value: string) => (value.length > 16 ? `${value.slice(0, 15)}…` : value)}
      />
      <EvilBarChart.Tooltip
        formatter={(value: unknown, _name: unknown, item: unknown) => {
          const detail = detailOf(item);
          return `${formatDuration(toMs(value))}${detail ? ` · ${detail}` : ""}`;
        }}
      />
      <EvilBarChart.Bar dataKey="value" variant="gradient" radius={4} />
    </EvilBarChart>
    </div>
  );
}

function ActivityChart({ days, range }: { days: Summary["days"]; range: RangeKey }) {
  const data = useMemo(() => {
    const bucketSize = Math.max(1, Math.ceil(days.length / 45));
    const buckets = bucketSize === 1 ? days.map((day) => ({ ...day, periodEnd: day.date })) : Array.from(
      { length: Math.ceil(days.length / bucketSize) },
      (_, index) => {
        const bucket = days.slice(index * bucketSize, (index + 1) * bucketSize);
        return {
          date: bucket[0]!.date,
          periodEnd: bucket.at(-1)!.date,
          workingMs: bucket.reduce((sum, day) => sum + day.workingMs, 0),
          agentRuntimeMs: bucket.reduce((sum, day) => sum + day.agentRuntimeMs, 0),
          agentCoverageMs: bucket.reduce((sum, day) => sum + day.agentCoverageMs, 0),
          activeMs: 0, computeMs: 0, coverageMs: 0,
          turnCount: bucket.reduce((sum, day) => sum + day.turnCount, 0),
          peakConcurrentTurns: Math.max(...bucket.map((day) => day.peakConcurrentTurns)),
        };
      },
    );
    return buckets.map((bucket) => ({
      label: bucket.periodEnd !== bucket.date
        ? `${formatDate(bucket.date)}–${formatDate(bucket.periodEnd)}`
        : formatDate(bucket.date, range === "today" || days.length <= 7),
      working: bucket.workingMs,
      agent: bucket.agentRuntimeMs,
      turns: bucket.turnCount,
    }));
  }, [days, range]);

  if (days.every((day) => day.workingMs === 0 && day.agentRuntimeMs === 0)) {
    return <EmptyPlot>Nothing tracked in this range yet.</EmptyPlot>;
  }

  return (
    <EvilAreaChart
      data={data}
      config={activityConfig}
      curveType="monotone"
      className="aspect-auto h-64 w-full"
      xDataKey="label"
    >
      <EvilAreaChart.Grid />
      <EvilAreaChart.XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tickMargin={10}
        minTickGap={24}
      />
      <EvilAreaChart.YAxis
        tickLine={false}
        axisLine={false}
        width={44}
        tickFormatter={(value: unknown) => formatDuration(toMs(value))}
      />
      <EvilAreaChart.Legend variant="circle" align="right" verticalAlign="top" />
      <EvilAreaChart.Tooltip formatter={(value: unknown) => formatDuration(toMs(value))} />
      <EvilAreaChart.Area dataKey="working" variant="gradient" strokeVariant="solid" strokeWidth={2}>
        <EvilAreaChart.ActiveDot variant="colored-border" />
      </EvilAreaChart.Area>
      <EvilAreaChart.Area dataKey="agent" variant="gradient" strokeVariant="solid" strokeWidth={2}>
        <EvilAreaChart.ActiveDot variant="colored-border" />
      </EvilAreaChart.Area>
    </EvilAreaChart>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading bb activity</span>
      <div className="bg-muted h-28 animate-pulse rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="bg-muted h-24 animate-pulse rounded-xl" key={index} />
        ))}
      </div>
      <div className="bg-muted h-72 animate-pulse rounded-xl" />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "time", title: "Activity", icon: "Clock", path: "time", component: Dashboard });
});

function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async (nextRange: RangeKey, initial = false) => {
    const generation = ++requestGeneration.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      const summary = await rpc.call("getSummary", { range: nextRange });
      if (generation !== requestGeneration.current) return;
      setData(summary as Summary);
      setError(null);
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation !== requestGeneration.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load(range, data === null);
    const timer = setInterval(() => void load(range), 30_000);
    return () => clearInterval(timer);
  }, [range, load]);

  const changeRange = (nextRange: RangeKey) => {
    if (nextRange === range) return;
    requestGeneration.current += 1;
    setRange(nextRange);
    setData(null);
    setError(null);
    setLoading(true);
  };

  const agents = useMemo(() => {
    if (!data) return [];
    const byProvider = new Map<string, { runtimeMs: number; turns: number; models: Set<string> }>();
    for (const row of data.models) {
      const entry = byProvider.get(row.providerId) ?? { runtimeMs: 0, turns: 0, models: new Set<string>() };
      entry.runtimeMs += row.agentRuntimeMs;
      entry.turns += row.turnCount;
      entry.models.add(shortModel(row.model));
      byProvider.set(row.providerId, entry);
    }
    return [...byProvider.entries()]
      .map(([providerId, entry]) => ({
        name: providerLabel(providerId),
        value: entry.runtimeMs,
        detail: `${entry.turns} turns`,
        models: entry.models.size,
      }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const topAgent = agents[0];
  const topModel = useMemo(() => {
    if (!data || data.models.length === 0) return null;
    return [...data.models].sort((a, b) => b.agentRuntimeMs - a.agentRuntimeMs)[0]!;
  }, [data]);
  const rangeBlurb = RANGES.find((option) => option.key === range)?.blurb ?? "";
  const heroParts = data ? splitDuration(data.workingMs) : [];

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-foreground text-lg font-medium tracking-tight">Activity</h1>
            <p className="text-muted-foreground text-xs">How hard bb has been working.</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
              {refreshing ? "updating…" : data
                ? `updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : ""}
            </span>
            <div className="bg-muted/60 flex items-center gap-0.5 rounded-lg p-0.5" role="radiogroup" aria-label="Date range">
              {RANGES.map((option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={range === option.key}
                  key={option.key}
                  onClick={() => changeRange(option.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition-colors",
                    range === option.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {loading && !data ? <LoadingState /> : null}

        {error && !data ? (
          <section className="border-border bg-card flex items-center justify-between gap-4 rounded-xl border p-4" role="alert">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Could not load activity</p>
              <p className="text-muted-foreground truncate text-xs">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void load(range, true)}
              className="border-border hover:bg-muted rounded-lg border px-3 py-1.5 text-xs"
            >
              Retry
            </button>
          </section>
        ) : null}

        {data ? (
          <div className="space-y-4" aria-busy={refreshing}>
            {error ? (
              <div className="border-border bg-muted/40 text-muted-foreground flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs" role="status">
                <span className="truncate">Showing the last good data — refresh failed.</span>
                <button type="button" onClick={() => void load(range)} className="text-foreground shrink-0 underline underline-offset-2">
                  Retry
                </button>
              </div>
            ) : null}

            <section className="bg-card border-border rounded-xl border p-5">
              <p className="text-muted-foreground text-xs">bb worked {rangeBlurb}</p>
              <p className="text-foreground mt-1 flex items-baseline gap-1 text-5xl font-semibold tracking-tight tabular-nums">
                {heroParts.map((part) => (
                  <span key={part.unit}>
                    {part.value}
                    <span className="text-muted-foreground text-2xl font-normal">{part.unit}</span>
                  </span>
                ))}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                {data.turnCount.toLocaleString()} turns across {data.projects.length} project{data.projects.length === 1 ? "" : "s"}
                {topAgent ? ` · ${topAgent.name} did the most` : ""}
              </p>
            </section>

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Highlights">
              <Stat
                label="Agent time"
                value={formatDuration(data.agentRuntimeMs)}
                detail={data.agentRuntimeMs > data.workingMs ? "beats the clock — agents run in parallel" : "summed turn time"}
              />
              <Stat
                label="Busiest agent"
                value={topAgent ? topAgent.name : "—"}
                detail={topAgent ? `${formatDuration(topAgent.value)} · ${topAgent.detail}` : "no attributed turns yet"}
              />
              <Stat
                label="Peak swarm"
                value={String(data.concurrency.peakConcurrentTurns)}
                unit="×"
                detail={`${data.concurrency.averageConcurrentTurns.toFixed(1)}× average · ${formatDuration(data.concurrency.swarmTimeMs)} in parallel`}
              />
              <Stat
                label="Streak"
                value={String(data.streak.currentDays)}
                unit={data.streak.currentDays === 1 ? "day" : "days"}
                detail={`best ${data.streak.longestDays} · busiest ${data.streak.busiestDay ? formatDate(data.streak.busiestDay.date) : "—"}`}
              />
            </section>

            <Card title="Daily activity" hint={data.range.timezone}>
              <ActivityChart days={data.days} range={range} />
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Busiest agents" hint="by agent time">
                <RankedBars
                  rows={agents.slice(0, 6)}
                  height={Math.max(140, agents.slice(0, 6).length * 40)}
                  emptyLabel="No agent turns attributed yet."
                />
              </Card>
              <Card title="Where the time went" hint="by working time">
                <RankedBars
                  rows={data.projects.slice(0, 6).map((row) => ({ name: row.name, value: row.workingMs }))}
                  height={Math.max(140, data.projects.slice(0, 6).length * 40)}
                  emptyLabel="No project activity yet."
                />
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Top models" hint="by agent time" className="lg:col-span-2">
                {data.models.length === 0 ? (
                  <EmptyPlot>No model attribution yet.</EmptyPlot>
                ) : (
                  <ul className="divide-border divide-y">
                    {[...data.models]
                      .sort((a, b) => b.agentRuntimeMs - a.agentRuntimeMs)
                      .slice(0, 5)
                      .map((row) => (
                        <li key={`${row.providerId}-${row.model}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: `var(--color-value-0, ${SERIES.working.light})` }}
                            />
                            <span className="text-foreground truncate text-sm">{shortModel(row.model)}</span>
                            <span className="text-muted-foreground shrink-0 text-xs">{providerLabel(row.providerId)}</span>
                          </div>
                          <span className="text-foreground shrink-0 text-sm tabular-nums">{formatDuration(row.agentRuntimeMs)}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </Card>

              <Card title="Rhythm">
                <dl className="grid grid-cols-2 gap-y-3">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Typical turn</dt>
                    <dd className="text-foreground text-sm tabular-nums">{formatDuration(data.pace.medianTurnMs)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Slowest 10%</dt>
                    <dd className="text-foreground text-sm tabular-nums">{formatDuration(data.pace.p90TurnMs)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Turns per hour</dt>
                    <dd className="text-foreground text-sm tabular-nums">{data.pace.turnsPerActiveHour.toFixed(1)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Longest wait</dt>
                    <dd className="text-foreground text-sm tabular-nums">{formatDuration(data.pace.longestIdleRunwayMs)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Machines</dt>
                    <dd className="text-foreground truncate text-sm">
                      {data.machines.length === 0 ? "—" : data.machines[0]!.name}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Busy share</dt>
                    <dd className="text-foreground text-sm tabular-nums">{Math.min(100, data.pace.coveragePercent).toFixed(0)}%</dd>
                  </div>
                </dl>
              </Card>
            </div>

            <p className="text-muted-foreground pb-2 text-center text-xs">
              {data.quality.sampledTurnCount.toLocaleString()} of {data.turnCount.toLocaleString()} turns carry model attribution
              {topModel ? ` · most used ${shortModel(topModel.model)}` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
