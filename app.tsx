import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { rpcContract } from "./server";
import "./app.css";

type RangeKey = "today" | "7d" | "30d" | "all";
type Summary = {
  range: { key: RangeKey; from: number; to: number; timezone: string };
  generatedAt: number;
  workingMs: number;
  agentRuntimeMs: number;
  agentCoverageMs: number;
  turnCount: number;
  days: Array<{
    date: string; workingMs: number; agentRuntimeMs: number; agentCoverageMs: number;
    turnCount: number; peakConcurrentTurns: number;
  }>;
  projects: Array<{ name: string; workingMs: number }>;
  machines: Array<{ name: string; workingMs: number }>;
  models: Array<{
    providerId: string; model: string; agentRuntimeMs: number;
    turnCount: number; sampledTurnCount: number;
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

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];

function formatDuration(ms: number, compact = false): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return compact || remaining === 0 ? `${hours}h${remaining ? ` ${remaining}m` : ""}` : `${hours}h ${remaining}m`;
}

function formatDate(date: string, short = false): string {
  const value = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, short
    ? { month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" }).format(value);
}

function MetricCard({ label, value, detail, title }: {
  label: string; value: string; detail: string; title?: string;
}) {
  return (
    <article className="waka-metric" title={title}>
      <p className="waka-eyebrow">{label}</p>
      <p className="waka-metric-value">{value}</p>
      <p className="waka-metric-detail">{detail}</p>
    </article>
  );
}

function Card({ title, subtitle, children, className = "" }: {
  title: string; subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`waka-card ${className}`}>
      <div className="waka-card-heading">
        <div className="waka-min-zero">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function ActivityChart({ days }: { days: Summary["days"] }) {
  const titleId = useId();
  const descriptionId = useId();
  if (days.every((day) => day.workingMs === 0 && day.agentRuntimeMs === 0)) {
    return <div className="waka-empty-chart">No observed agent intervals in this range.</div>;
  }
  const bucketSize = Math.max(1, Math.ceil(days.length / 60));
  const chartDays = bucketSize === 1 ? days : Array.from(
    { length: Math.ceil(days.length / bucketSize) },
    (_, index) => {
      const bucket = days.slice(index * bucketSize, (index + 1) * bucketSize);
      return {
        date: bucket[0]!.date,
        periodEnd: bucket.at(-1)!.date,
        workingMs: bucket.reduce((sum, day) => sum + day.workingMs, 0),
        agentRuntimeMs: bucket.reduce((sum, day) => sum + day.agentRuntimeMs, 0),
        agentCoverageMs: bucket.reduce((sum, day) => sum + day.agentCoverageMs, 0),
        turnCount: bucket.reduce((sum, day) => sum + day.turnCount, 0),
        peakConcurrentTurns: Math.max(...bucket.map((day) => day.peakConcurrentTurns)),
      };
    },
  );
  const width = 920;
  const height = 250;
  const left = 44;
  const right = 14;
  const top = 16;
  const bottom = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...chartDays.flatMap((day) => [day.workingMs, day.agentRuntimeMs, day.agentCoverageMs]));
  const slot = plotWidth / Math.max(1, chartDays.length);
  const barWidth = Math.max(3, Math.min(22, slot * 0.58));
  const tickEvery = Math.max(1, Math.ceil(chartDays.length / 8));
  const y = (value: number) => top + plotHeight - (value / maximum) * plotHeight;
  const runtimePoints = chartDays.map((day, index) => `${left + slot * (index + 0.5)},${y(day.agentRuntimeMs)}`).join(" ");

  return (
    <div className="waka-chart-wrap" tabIndex={chartDays.length > 14 ? 0 : undefined}
      aria-label={chartDays.length > 14 ? "Scrollable activity chart" : undefined}>
      <svg className="waka-activity-chart" viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: `${chartDays.length > 14 ? Math.min(1100, Math.max(560, chartDays.length * 18)) : 520}px` }}
        role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>Activity over time</title>
        <desc id={descriptionId}>Daily unioned working time, unioned agent coverage, and summed agent runtime.</desc>
        {[0, 0.5, 1].map((ratio) => (
          <line key={ratio} className="waka-grid-line" x1={left} x2={width - right}
            y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} />
        ))}
        {chartDays.map((day, index) => {
          const x = left + slot * (index + 0.5);
          const workingHeight = Math.max(0, plotHeight - (y(day.workingMs) - top));
          const coverageHeight = Math.max(0, plotHeight - (y(day.agentCoverageMs) - top));
          const periodEnd = "periodEnd" in day && typeof day.periodEnd === "string"
            ? day.periodEnd
            : day.date;
          const periodLabel = periodEnd !== day.date
            ? `${formatDate(day.date)}–${formatDate(periodEnd, true)}`
            : formatDate(day.date);
          const label = `${periodLabel}: ${formatDuration(day.workingMs)} working, ${formatDuration(day.agentCoverageMs)} agent coverage, ${formatDuration(day.agentRuntimeMs)} summed agent runtime, ${day.turnCount} turns`;
          return (
            <g key={day.date} tabIndex={chartDays.length <= 14 ? 0 : undefined}
              role="img" aria-label={label} className="waka-chart-day">
              <title>{label}</title>
              <rect className="waka-working-bar" x={x - barWidth / 2} y={y(day.workingMs)}
                width={barWidth} height={workingHeight} rx="3" />
              <rect className="waka-coverage-bar" x={x - barWidth / 4} y={y(day.agentCoverageMs)}
                width={barWidth / 2} height={coverageHeight} rx="2" />
              {(index % tickEvery === 0 || index === chartDays.length - 1) ? (
                <text className="waka-axis-label" x={x} y={height - 10} textAnchor="middle">
                  {formatDate(day.date, true)}
                </text>
              ) : null}
            </g>
          );
        })}
        {chartDays.length > 1 ? <polyline className="waka-runtime-line" points={runtimePoints} /> : null}
        {chartDays.map((day, index) => (
          <circle key={day.date} className="waka-runtime-dot"
            cx={left + slot * (index + 0.5)} cy={y(day.agentRuntimeMs)} r="3" />
        ))}
      </svg>
    </div>
  );
}

function BreakdownCard({ title, subtitle, rows, valueLabel = formatDuration }: {
  title: string; subtitle: string;
  rows: Array<{ name: string; value: number; detail?: string }>;
  valueLabel?: (value: number) => string;
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return (
    <Card title={title} subtitle={subtitle}>
      {rows.length === 0 ? <div className="waka-empty-small">No attributable intervals yet.</div> : (
        <div className="waka-breakdown-list">
          {rows.slice(0, 7).map((row) => (
            <div className="waka-breakdown-row" key={row.name} title={row.name}>
              <div className="waka-breakdown-label">
                <span>{row.name}</span>
                <span>{valueLabel(row.value)}{row.detail ? ` · ${row.detail}` : ""}</span>
              </div>
              <div className="waka-track" aria-hidden="true">
                <span style={{ width: `${(row.value / maximum) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ConcurrencyCard({ data }: { data: Summary }) {
  const distribution = data.concurrency.distribution;
  const total = Math.max(1, distribution.reduce((sum, row) => sum + row.durationMs, 0));
  return (
    <Card title="Concurrency" subtitle="Duration by simultaneous observed turns">
      <div className="waka-concurrency-headlines">
        <div><span>Average</span><strong>{data.concurrency.averageConcurrentTurns.toFixed(2)}×</strong></div>
        <div><span>Peak</span><strong>{data.concurrency.peakConcurrentTurns}</strong></div>
        <div><span>Swarm</span><strong>{formatDuration(data.concurrency.swarmTimeMs)}</strong></div>
      </div>
      {distribution.length === 0 ? <div className="waka-empty-small">No concurrent turns in this range.</div> : (
        <>
          <div className="waka-concurrency-stack" aria-label="Concurrency duration distribution">
            {distribution.map((row) => (
              <span key={row.concurrentTurns} title={`${row.concurrentTurns} simultaneous: ${formatDuration(row.durationMs)}`}
                style={{ width: `${(row.durationMs / total) * 100}%` }} />
            ))}
          </div>
          <div className="waka-concurrency-legend">
            {distribution.map((row) => (
              <span key={row.concurrentTurns}><i />{row.concurrentTurns}× · {formatDuration(row.durationMs)}</span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function ProjectModelCard({ rows }: { rows: Summary["projectModels"] }) {
  return (
    <Card title="Project × model" subtitle="Only session-linked turns sampled near their start">
      {rows.length === 0 ? <div className="waka-empty-small">No sampled linked attribution in this range.</div> : (
        <div className="waka-project-models">
          {rows.slice(0, 8).map((row) => (
            <div key={`${row.projectName}-${row.providerId}-${row.model}`}>
              <span title={row.projectName}>{row.projectName}</span>
              <span title={`${row.providerId} / ${row.model}`}>{row.model.split("/").at(-1)}</span>
              <strong>{formatDuration(row.agentRuntimeMs)}</strong>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="waka-loading" aria-live="polite" aria-busy="true">
      <span className="waka-visually-hidden">Loading agent analytics</span>
      <div className="waka-skeleton waka-skeleton-tabs" />
      <div className="waka-metric-grid">{Array.from({ length: 6 }, (_, index) => <div className="waka-skeleton waka-skeleton-metric" key={index} />)}</div>
      <div className="waka-skeleton waka-skeleton-chart" />
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

  return (
    <main className="waka-shell">
      <div className="waka-page">
        <header className="waka-page-header">
          <div className="waka-min-zero">
            <p className="waka-kicker">Interval analytics</p>
            <h1>Agent activity</h1>
            <p>What bb can measure from active threads and turns—no token, cost, language, or productivity guesses.</p>
          </div>
          <div className="waka-status" aria-live="polite">
            {refreshing ? "Updating…" : data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </div>
        </header>

        <div className="waka-range" role="radiogroup" aria-label="Analytics date range">
          {RANGES.map((option) => (
            <button type="button" role="radio" aria-checked={range === option.key}
              key={option.key} onClick={() => changeRange(option.key)}>
              {option.label}
            </button>
          ))}
        </div>

        {loading && !data ? <LoadingState /> : null}
        {error && !data ? (
          <section className="waka-error" role="alert">
            <div><strong>Analytics could not load</strong><p>{error}</p></div>
            <button type="button" onClick={() => void load(range, true)}>Retry</button>
          </section>
        ) : null}

        {data ? (
          <div className="waka-dashboard" aria-busy={refreshing}>
            {error ? (
              <div className="waka-refresh-error" role="status">
                Showing the last loaded data. Refresh failed: {error}
                <button type="button" onClick={() => void load(range)}>Retry</button>
              </div>
            ) : null}

            <div className="waka-definition-strip" aria-label="Measurement definitions">
              <span><i className="waka-key-working" />Working time <small>union of active threads</small></span>
              <span><i className="waka-key-runtime" />Agent runtime <small>sum of turn durations</small></span>
              <span><i className="waka-key-coverage" />Agent coverage <small>union of turn durations</small></span>
            </div>

            <section className="waka-metric-grid" aria-label="Summary metrics">
              <MetricCard label="Working time" value={formatDuration(data.workingMs)} detail="Active thread union" />
              <MetricCard label="Agent runtime" value={formatDuration(data.agentRuntimeMs)} detail="Summed turn durations" />
              <MetricCard label="Agent coverage" value={formatDuration(data.agentCoverageMs)} detail="Turn interval union" />
              <MetricCard label="Coverage of work" value={`${Math.min(100, data.pace.coveragePercent).toFixed(0)}%`} detail={`${formatDuration(data.pace.idleRunwayMs)} uncovered`} />
              <MetricCard label="Concurrent turns" value={`${data.concurrency.averageConcurrentTurns.toFixed(2)}×`} detail={`${data.concurrency.peakConcurrentTurns} peak`} />
              <MetricCard label="Turns" value={data.turnCount.toLocaleString()} detail={`${data.pace.turnsPerActiveHour.toFixed(1)} per active hour`} />
            </section>

            <Card title="Activity" subtitle={`${data.range.timezone} · runtime may exceed coverage during parallel work`} className="waka-activity-card">
              <ActivityChart days={data.days} />
              <div className="waka-chart-legend" aria-hidden="true">
                <span><i className="waka-key-working" />Working</span>
                <span><i className="waka-key-coverage" />Coverage</span>
                <span><i className="waka-key-runtime" />Runtime</span>
              </div>
            </Card>

            <div className="waka-analysis-grid">
              <BreakdownCard title="Projects" subtitle="Unioned working intervals; projects can overlap"
                rows={data.projects.map((row) => ({ name: row.name, value: row.workingMs }))} />
              <BreakdownCard title="Models" subtitle="Runtime sampled near live turn starts"
                rows={data.models.map((row) => ({
                  name: `${row.providerId} · ${row.model}`, value: row.agentRuntimeMs,
                  detail: `${row.turnCount} turns`,
                }))} />
              <BreakdownCard title="Machines" subtitle="Unioned working intervals; machines can overlap"
                rows={data.machines.map((row) => ({ name: row.name, value: row.workingMs }))} />
              <ConcurrencyCard data={data} />
              <ProjectModelCard rows={data.projectModels} />
              <Card title="Rhythm" subtitle="Descriptive interval metrics, not productivity scores">
                <div className="waka-fun-grid">
                  <div><span>Median turn</span><strong>{formatDuration(data.pace.medianTurnMs)}</strong></div>
                  <div><span>p90 turn</span><strong>{formatDuration(data.pace.p90TurnMs)}</strong></div>
                  <div><span>Longest runway</span><strong>{formatDuration(data.pace.longestIdleRunwayMs)}</strong></div>
                  <div><span>Current streak</span><strong>{data.streak.currentDays}d</strong></div>
                  <div><span>Longest streak</span><strong>{data.streak.longestDays}d</strong></div>
                  <div><span>Busiest day</span><strong>{data.streak.busiestDay ? formatDate(data.streak.busiestDay.date, true) : "—"}</strong></div>
                </div>
              </Card>
            </div>

            <footer className="waka-quality">
              <strong>Measurement quality</strong>
              <span>{data.quality.sessionCount} session intervals</span>
              <span>{data.quality.sampledTurnCount}/{data.turnCount} turns sampled near start</span>
              {data.quality.unknownModelTurnCount > 0 ? <span>{data.quality.unknownModelTurnCount} unknown model</span> : null}
              {data.quality.recoveredSessionCount + data.quality.recoveredTurnCount > 0 ? (
                <span>{data.quality.recoveredSessionCount + data.quality.recoveredTurnCount} crash-bounded intervals</span>
              ) : null}
            </footer>
          </div>
        ) : null}
      </div>
    </main>
  );
}
