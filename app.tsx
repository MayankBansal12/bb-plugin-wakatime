import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LabelList } from "recharts";
import type { rpcContract } from "./server";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { cn } from "@/lib/utils";
import "./styles.css";

type RangeKey = "today" | "7d" | "30d" | "all";

type Breakdown = { name: string; workingMs: number; activeMs: number };

type Day = {
  date: string; workingMs: number; agentRuntimeMs: number; agentCoverageMs: number;
  activeMs: number; computeMs: number; coverageMs: number;
  turnCount: number; peakConcurrentTurns: number;
};

type Summary = {
  range: { key: RangeKey; from: number; to: number; timezone: string };
  generatedAt: number;
  workingMs: number;
  agentRuntimeMs: number;
  agentCoverageMs: number;
  totalActiveMs: number;
  totalComputeMs: number;
  turnCount: number;
  days: Day[];
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

// One green hue. Series step and the 4-step heatmap ramp are validated for
// lightness band, chroma, monotonicity and contrast against bb's own light
// (#ffffff) and dark (#151515) canvases. Chart chrome stays on theme tokens.
const PALETTE = {
  series: { light: "#2f9e6a", dark: "#2eae74" },
  ramp: {
    light: ["#72c59a", "#48ab7e", "#2b8c62", "#1a6b49"],
    dark: ["#22593c", "#2b7d55", "#359f6d", "#45c98b"],
  },
} as const;

const barConfig = {
  value: { label: "Time", colors: { light: [PALETTE.series.light], dark: [PALETTE.series.dark] } },
} satisfies ChartConfig;

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 53;

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

/** Chart labels must not wrap, and recharts breaks on spaces. */
function formatTight(ms: number): string {
  return formatDuration(ms).replace(" ", "\u00a0");
}

const TICK_STEPS = [
  15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000,
  4 * 3_600_000, 8 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

/** Round axis ticks so they read "2h", not "1h 57m". */
function hourTicks(maxMs: number): { ticks: number[]; max: number } {
  if (maxMs <= 0) return { ticks: [0], max: 1 };
  const step = TICK_STEPS.find((candidate) => maxMs / candidate <= 3) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const max = Math.ceil(maxMs / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { ticks, max };
}

function toMs(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function formatDate(date: string, withWeekday = false): string {
  const value = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, withWeekday
    ? { weekday: "short", month: "short", day: "numeric" }
    : { month: "short", day: "numeric" }).format(value);
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shortModel(model: string): string {
  if (isUnknown(model)) return "Model not recorded";
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

function providerLabel(providerId: string): string {
  const known: Record<string, string> = {
    "acp-claude-code": "Claude Code",
    "acp-opencode": "OpenCode",
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    pi: "Pi",
  };
  if (isUnknown(providerId)) return "Unattributed agent";
  const normalized = providerId.trim().toLowerCase();
  return known[normalized] ?? normalized
    .replace(/^acp-/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isUnknown(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "unset" || normalized === "n/a";
}

function dimensionLabel(value: string, kind: "project" | "machine"): string {
  if (!isUnknown(value)) return value;
  return kind === "machine" ? "Unidentified machine" : "Unassigned project";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

type IconName = "activity" | "agent" | "calendar" | "clock" | "flame" | "machine" | "model" | "project" | "sparkles";

const ICON_PATHS: Record<IconName, ReactNode> = {
  activity: <><path d="M3 12h3l2-6 4 12 2-6h7" /></>,
  agent: <><rect x="4" y="5" width="16" height="14" rx="4" /><path d="M9 10h.01M15 10h.01M9 15h6M12 2v3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  flame: <><path d="M12 22c4 0 7-3 7-7 0-3-2-6-5-9 0 3-1 5-3 6 0-4-2-7-4-9 0 5-3 7-3 12 0 4 4 7 8 7Z" /></>,
  machine: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  model: <><path d="m12 3 2.1 4.9L19 10l-4.9 2.1L12 17l-2.1-4.9L5 10l4.9-2.1L12 3Z" /><path d="m19 16 .8 1.8L22 19l-2.2 1.2L19 22l-.8-1.8L16 19l2.2-1.2L19 16Z" /></>,
  project: <><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h5" /></>,
  sparkles: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className={cn("size-4 shrink-0", className)}>
      {ICON_PATHS[name]}
    </svg>
  );
}

function ProviderLogo({ providerId, label }: { providerId: string; label?: string }) {
  const normalized = providerId.trim().toLowerCase();
  const name = label ?? providerLabel(providerId);
  const mark = normalized.includes("claude") ? "A" : normalized.includes("open") ? "O" : normalized === "pi" ? "π" : normalized.includes("codex") ? "◈" : "?";
  const tone = normalized.includes("claude") ? "claude" : normalized.includes("open") ? "opencode" : normalized === "pi" ? "pi" : normalized.includes("codex") ? "codex" : "unknown";
  return <span className="wk-provider-logo" data-provider={tone} data-wk-tooltip={name} aria-label={name}>{mark}</span>;
}

function Card({ title, note, icon, action, children, className }: {
  title?: string; note?: string; icon?: IconName; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn("bg-card border-border flex min-w-0 flex-col rounded-xl border p-4", className)}>
      {title ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-foreground flex min-w-0 items-center gap-2 text-[13px] leading-none font-medium"
            data-wk-tooltip={note} tabIndex={note ? 0 : undefined}>
            {icon ? <Icon name={icon} className="text-muted-foreground" /> : null}
            <span className="truncate">{title}</span>
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function Metric({ label, value, unit, detail, icon, logo }: {
  label: string; value: string; unit?: string; detail?: string; icon: IconName; logo?: ReactNode;
}) {
  return (
    <div className="bg-card border-border min-w-0 rounded-xl border p-4">
      <p className="text-muted-foreground flex items-center gap-1.5 truncate text-[11px] leading-none opacity-80">
        <Icon name={icon} className="size-3.5" /> {label}
      </p>
      <p className="text-foreground mt-2.5 flex min-w-0 items-center gap-2 text-[22px] leading-none font-semibold tracking-tight tabular-nums">
        {logo}
        <span className="truncate" data-wk-tooltip={value}>{value}</span>
        {unit ? <span className="text-muted-foreground ml-1 text-sm font-normal">{unit}</span> : null}
      </p>
      {detail ? <p className="text-muted-foreground mt-2 truncate text-[11px] leading-none opacity-70">{detail}</p> : null}
    </div>
  );
}

function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex items-center justify-center py-8 text-center text-xs", className)}>
      {children}
    </div>
  );
}

/** GitHub-style daily activity heatmap over the trailing 53 weeks. */
const CELL = 10;
const CELL_GAP = 3;
const PITCH = CELL + CELL_GAP;
const WEEKDAY_COL = 30;
const LABEL_GAP = 6;

function ContributionGraph({ days, timezone }: { days: Day[]; timezone: string }) {
  const [hoveredCell, setHoveredCell] = useState<{ text: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { weeks, months, thresholds } = useMemo(() => {
    const byDate = new Map(days.map((day) => [day.date, day]));

    // End on the current week's Saturday so every column is a whole week.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = today.getTime() + (6 - today.getDay()) * DAY_MS;
    const start = end - (HEATMAP_WEEKS * 7 - 1) * DAY_MS;

    const cells: Array<Array<{ date: string; workingMs: number; turnCount: number; future: boolean }>> = [];
    const monthLabels: Array<{ index: number; label: string }> = [];
    let lastMonth = -1;

    for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
      const column = Array.from({ length: 7 }, (_, weekday) => {
        const stamp = start + (week * 7 + weekday) * DAY_MS;
        const date = localDayKey(stamp);
        const day = byDate.get(date);
        return {
          date,
          workingMs: day?.workingMs ?? 0,
          turnCount: day?.turnCount ?? 0,
          future: stamp > today.getTime(),
        };
      });

      const monthOfColumn = new Date(start + week * 7 * DAY_MS).getMonth();
      // Label a month on the first column that belongs to it, but only when the
      // previous label is far enough back that the two cannot collide.
      const previous = monthLabels[monthLabels.length - 1];
      if (monthOfColumn !== lastMonth && (!previous || week - previous.index >= 3) && week <= HEATMAP_WEEKS - 3) {
        monthLabels.push({
          index: week,
          label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(start + week * 7 * DAY_MS),
        });
      }
      lastMonth = monthOfColumn;
      cells.push(column);
    }

    const worked = days.map((day) => day.workingMs).filter((value) => value > 0).sort((a, b) => a - b);
    const at = (fraction: number) =>
      worked.length === 0 ? 0 : worked[Math.min(worked.length - 1, Math.floor(worked.length * fraction))]!;
    return { weeks: cells, months: monthLabels, thresholds: [at(0.25), at(0.5), at(0.75)] };
  }, [days]);

  const levelOf = (workingMs: number): number => {
    if (workingMs <= 0) return 0;
    if (workingMs <= thresholds[0]!) return 1;
    if (workingMs <= thresholds[1]!) return 2;
    if (workingMs <= thresholds[2]!) return 3;
    return 4;
  };

  const gridWidth = WEEKDAY_COL + HEATMAP_WEEKS * PITCH - CELL_GAP;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
  }, [gridWidth]);

  const showCellTooltip = (element: HTMLElement, text: string, x?: number, y?: number) => {
    const rect = element.getBoundingClientRect();
    setHoveredCell({
      text,
      x: Math.min(window.innerWidth - 12, Math.max(12, x ?? rect.left + rect.width / 2)),
      y: Math.max(12, y ?? rect.top),
    });
  };

  return (
    <div data-wk-heat>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-foreground flex items-center gap-2 text-[13px] leading-none font-medium"
          data-wk-tooltip={`Daily working time · ${timezone}`} tabIndex={0}>
          <Icon name="calendar" className="text-muted-foreground" /> Every day bb worked
        </h2>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px] leading-none opacity-70">
          less
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: `var(--wk-l${level})` }}
            />
          ))}
          more
        </span>
      </div>

      <div ref={scrollRef} className="overflow-x-auto pb-0.5" aria-label="Daily working time for the trailing year">
        <div style={{ width: "100%", minWidth: gridWidth }}>
          {/* month row: absolutely placed so each label sits over its own column */}
          <div className="relative" style={{ height: 14, marginBottom: CELL_GAP, marginLeft: WEEKDAY_COL }}>
            {months.map((month) => (
              <span key={`${month.label}-${month.index}`}
                className="text-muted-foreground absolute top-0 text-[10px] leading-[14px] opacity-70"
                style={{ left: `${(month.index / (HEATMAP_WEEKS - 1)) * 100}%` }}>
                {month.label}
              </span>
            ))}
          </div>

          <div className="flex">
            <div
              className="grid shrink-0"
              style={{
                width: WEEKDAY_COL,
                paddingRight: LABEL_GAP,
                gridTemplateRows: `repeat(7, ${CELL}px)`,
                rowGap: CELL_GAP,
              }}
            >
              {["", "Mon", "", "Wed", "", "Fri", ""].map((label, index) => (
                <span
                  key={index}
                  className="text-muted-foreground text-right text-[10px] opacity-70"
                  style={{ lineHeight: `${CELL}px` }}
                >
                  {label}
                </span>
              ))}
            </div>

            <div
              className="grid min-w-0 flex-1"
              style={{
                gridAutoFlow: "column",
                gridTemplateRows: `repeat(7, ${CELL}px)`,
                gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, ${CELL}px)`,
                rowGap: CELL_GAP,
                justifyContent: "space-between",
              }}
            >
              {weeks.flatMap((column) =>
                column.map((cell) =>
                  cell.future ? (
                    <span key={cell.date} style={{ width: CELL, height: CELL }} />
                  ) : (
                    <span
                      key={cell.date}
                      aria-label={`${formatDate(cell.date, true)}, ${formatDuration(cell.workingMs)}${cell.turnCount > 0 ? `, ${cell.turnCount} turns` : ""}`}
                      onMouseEnter={(event) => showCellTooltip(event.currentTarget, event.currentTarget.getAttribute("aria-label") ?? "")}
                      onMouseMove={(event) => showCellTooltip(event.currentTarget, event.currentTarget.getAttribute("aria-label") ?? "", event.clientX, event.clientY - 10)}
                      onMouseLeave={() => setHoveredCell(null)}
                      className="wk-heat-cell transition-opacity duration-100 ease-out hover:opacity-70"
                      style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: `var(--wk-l${levelOf(cell.workingMs)})` }}
                    />
                  ),
                ),
              )}
            </div>
          </div>
        </div>
      </div>
      {hoveredCell ? (
        <div role="tooltip" className="wk-graph-tooltip"
          style={{ left: hoveredCell.x, top: hoveredCell.y, transform: "translate(-50%, -100%)" }}>
          {hoveredCell.text}
        </div>
      ) : null}
    </div>
  );
}

/** Daily working time. Bars, not an area — one day is still a readable chart. */
function DailyChart({ days }: { days: Day[] }) {
  const data = useMemo(() => {
    const bucketSize = Math.max(1, Math.ceil(days.length / 31));
    const buckets = bucketSize === 1 ? days.map((day) => ({ from: day.date, to: day.date, day })) : Array.from(
      { length: Math.ceil(days.length / bucketSize) },
      (_, index) => {
        const slice = days.slice(index * bucketSize, (index + 1) * bucketSize);
        return {
          from: slice[0]!.date,
          to: slice[slice.length - 1]!.date,
          day: {
            workingMs: slice.reduce((sum, entry) => sum + entry.workingMs, 0),
            turnCount: slice.reduce((sum, entry) => sum + entry.turnCount, 0),
          },
        };
      },
    );
    return buckets.map((bucket) => ({
      label: bucket.from === bucket.to ? formatDate(bucket.from) : `${formatDate(bucket.from)}–${formatDate(bucket.to)}`,
      value: bucket.day.workingMs,
      turns: bucket.day.turnCount,
    }));
  }, [days]);

  const scale = useMemo(
    () => hourTicks(Math.max(0, ...data.map((point) => point.value))),
    [data],
  );

  if (days.every((day) => day.workingMs === 0)) {
    return <Empty className="h-48">Nothing tracked in this range yet.</Empty>;
  }

  return (
    <div className="h-48 w-full">
      <EvilBarChart
        data={data}
        config={barConfig}
        barRadius={3}
        barCategoryGap={data.length > 14 ? 2 : 8}
        className="aspect-auto h-full w-full"
        xDataKey="label"
      >
        <EvilBarChart.Grid />
        <EvilBarChart.XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={20}
          interval="preserveStartEnd"
        />
        <EvilBarChart.YAxis
          tickLine={false}
          axisLine={false}
          width={46}
          domain={[0, scale.max]}
          ticks={scale.ticks}
          tickFormatter={(value: unknown) => (toMs(value) === 0 ? "0" : formatTight(toMs(value)))}
        />
        <EvilBarChart.Tooltip formatter={(value: unknown, _name: unknown, item: { payload?: { turns?: number } }) => (
          <div className="flex min-w-40 items-center justify-between gap-4">
            <span className="text-muted-foreground">Working time</span>
            <span className="text-foreground font-medium tabular-nums">{formatDuration(toMs(value))}</span>
            {item.payload?.turns ? <span className="text-muted-foreground">{item.payload.turns} turns</span> : null}
          </div>
        )} />
        <EvilBarChart.Bar dataKey="value" variant="default" radius={3} barProps={{ maxBarSize: 44 }} />
      </EvilBarChart>
    </div>
  );
}

/** Horizontal ranked bars with the value written at the end of each bar. */
function Leaderboard({ rows, emptyLabel }: {
  rows: Array<{ name: string; value: number; detail?: string }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) return <Empty>{emptyLabel}</Empty>;
  const data = rows.map((row) => ({
    name: row.name,
    value: row.value,
    detail: row.detail ?? "",
  }));
  return (
    <div style={{ height: Math.max(96, data.length * 30 + 8) }} className="w-full">
      <EvilBarChart
        data={data}
        config={barConfig}
        layout="horizontal"
        barRadius={3}
        className="aspect-auto h-full w-full"
        xDataKey="name"
        chartProps={{ margin: { left: 0, right: 62, top: 0, bottom: 0 } }}
      >
        <EvilBarChart.XAxis type="number" dataKey="value" hide />
        <EvilBarChart.YAxis
          type="category"
          dataKey="name"
          width={110}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tickFormatter={(value: unknown) => truncate(String(value), 14)}
        />
        <EvilBarChart.Tooltip formatter={(value: unknown, _name: unknown, item: { payload?: { detail?: string } }) => (
          <div className="flex min-w-36 items-center justify-between gap-4">
            <span className="text-muted-foreground">Time</span>
            <span className="text-foreground font-medium tabular-nums">{formatDuration(toMs(value))}</span>
            {item.payload?.detail ? <span className="text-muted-foreground">{item.payload.detail}</span> : null}
          </div>
        )} />
        <EvilBarChart.Bar
          dataKey="value"
          variant="default"
          radius={3}
          barProps={{
            barSize: 14,
            children: (
              <LabelList
                dataKey="value"
                position="right"
                offset={8}
                className="fill-muted-foreground"
                fontSize={11}
                formatter={(value: unknown) => formatTight(toMs(value))}
              />
            ),
          }}
        />
      </EvilBarChart>
    </div>
  );
}

function Rows({ items }: { items: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground truncate text-[11px] leading-none opacity-70" data-wk-tooltip={item.label}>{item.label}</dt>
          <dd className="text-foreground mt-2 truncate text-[13px] leading-none font-medium tabular-nums">
            {item.value}
            {item.hint ? <span className="text-muted-foreground ml-1 font-normal text-[11px] opacity-70">{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading bb activity</span>
      <div className="bg-muted h-24 animate-pulse rounded-xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div className="bg-muted h-[74px] animate-pulse rounded-xl" key={index} />)}
      </div>
      <div className="bg-muted h-40 animate-pulse rounded-xl" />
      <div className="bg-muted h-56 animate-pulse rounded-xl" />
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
  const [history, setHistory] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async (nextRange: RangeKey, initial = false) => {
    const generation = ++requestGeneration.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      // The heatmap always shows the trailing year, whatever range is selected.
      const [summary, allTime] = await Promise.all([
        rpc.call("getSummary", { range: nextRange }),
        nextRange === "all" ? null : rpc.call("getSummary", { range: "all" }),
      ]);
      if (generation !== requestGeneration.current) return;
      setData(summary as Summary);
      setHistory((allTime ?? summary) as Summary);
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
    const byProvider = new Map<string, { providerId: string; runtimeMs: number; turns: number; unattributed: boolean }>();
    for (const row of data.models) {
      const name = providerLabel(row.providerId);
      const entry = byProvider.get(name) ?? {
        providerId: row.providerId,
        runtimeMs: 0,
        turns: 0,
        unattributed: isUnknown(row.providerId),
      };
      entry.runtimeMs += row.agentRuntimeMs;
      entry.turns += row.turnCount;
      byProvider.set(name, entry);
    }
    return [...byProvider.entries()]
      .map(([name, entry]) => ({
        name,
        providerId: entry.providerId,
        value: entry.runtimeMs,
        detail: entry.unattributed ? `${entry.turns} older turns` : `${entry.turns} turns`,
        unattributed: entry.unattributed,
      }))
      .sort((a, b) => Number(a.unattributed) - Number(b.unattributed) || b.value - a.value);
  }, [data]);

  const topAgent = agents.find((agent) => !agent.unattributed) ?? agents[0];
  const topModel = useMemo(() => {
    if (!data || data.models.length === 0) return null;
    return [...data.models]
      .filter((row) => !isUnknown(row.model))
      .sort((a, b) => b.agentRuntimeMs - a.agentRuntimeMs)[0] ?? null;
  }, [data]);
  const rangeBlurb = RANGES.find((option) => option.key === range)?.blurb ?? "";
  const heroParts = data ? splitDuration(data.workingMs) : [];

  return (
    <main className="h-full overflow-y-auto" data-wk-root>
      <div className="wk-dashboard-shell w-full space-y-3 p-4 md:p-5">
        <header className="flex justify-end">
          <div
            className="bg-muted flex shrink-0 items-center gap-0.5 rounded-lg p-0.5"
            role="radiogroup"
            aria-label="Date range"
          >
            {RANGES.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={range === option.key}
                key={option.key}
                onClick={() => changeRange(option.key)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs leading-none transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out active:[transform:scale(.97)]",
                  range === option.key
                    ? "bg-background text-foreground border-border border shadow-sm"
                    : "text-muted-foreground hover:text-foreground border border-transparent",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>

        {loading && !data ? <LoadingState /> : null}

        {error && !data ? (
          <section className="border-border bg-card flex items-center justify-between gap-4 rounded-xl border p-4" role="alert">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Could not load activity</p>
              <p className="text-muted-foreground mt-1 truncate text-xs">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void load(range, true)}
              className="border-border hover:bg-muted shrink-0 rounded-lg border px-3 py-1.5 text-xs transition-[color,background-color,border-color,transform] duration-150 ease-out active:[transform:scale(.97)]"
            >
              Retry
            </button>
          </section>
        ) : null}

        {data ? (
          <div className="space-y-3" aria-busy={refreshing}>
            {error ? (
              <div className="border-border bg-muted text-muted-foreground flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs" role="status">
                <span className="truncate">Showing the last good data — refresh failed.</span>
                <button type="button" onClick={() => void load(range)} className="text-foreground shrink-0 underline underline-offset-2">
                  Retry
                </button>
              </div>
            ) : null}

            <section className="bg-card border-border min-w-0 rounded-xl border p-4">
              <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] leading-none opacity-80">
                <Icon name="sparkles" className="size-3.5" /> bb worked {rangeBlurb}
              </p>
              <p className="text-foreground mt-2.5 flex items-baseline gap-1.5 text-[40px] leading-none font-semibold tracking-tight tabular-nums">
                {heroParts.map((part) => (
                  <span key={part.unit}>
                    {part.value}
                    <span className="text-muted-foreground ml-0.5 text-xl font-normal">{part.unit}</span>
                  </span>
                ))}
              </p>
              <p className="text-muted-foreground mt-2.5 text-[11px] leading-none">
                <span className="text-foreground font-medium">{data.turnCount.toLocaleString()}</span> turns across{" "}
                <span className="text-foreground font-medium">{data.projects.length}</span>{" "}
                project{data.projects.length === 1 ? "" : "s"}
              </p>
            </section>

            <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Highlights">
              <Metric
                label="Agent time"
                icon="clock"
                value={formatDuration(data.agentRuntimeMs)}
                detail={data.agentRuntimeMs > data.workingMs ? "beats the clock" : "summed turn time"}
              />
              <Metric
                label="Busiest agent"
                icon="agent"
                value={topAgent ? topAgent.name : "—"}
                logo={topAgent ? <ProviderLogo providerId={topAgent.providerId} label={topAgent.name} /> : undefined}
                detail={topAgent ? formatDuration(topAgent.value) : "nothing attributed"}
              />
              <Metric
                label="Peak swarm"
                icon="activity"
                value={String(data.concurrency.peakConcurrentTurns)}
                unit="×"
                detail={`${data.concurrency.averageConcurrentTurns.toFixed(1)}× average`}
              />
              <Metric
                label="Streak"
                icon="flame"
                value={String(data.streak.currentDays)}
                unit={data.streak.currentDays === 1 ? "day" : "days"}
                detail={`best ${data.streak.longestDays}`}
              />
            </section>

            {history ? (
              <Card>
                <ContributionGraph days={history.days} timezone={data.range.timezone} />
              </Card>
            ) : null}

            <Card title="Daily activity" note="Union of active thread time, per day" icon="activity">
              <DailyChart days={data.days} />
            </Card>

            <div className="grid items-start gap-3 md:grid-cols-2">
              <Card title="Busiest agents" note="Summed turn duration per provider" icon="agent">
                <Leaderboard rows={agents.slice(0, 5)} emptyLabel="No agent turns attributed yet." />
              </Card>
              <Card title="Projects" note="Union of active thread time per project" icon="project">
                <Leaderboard
                  rows={data.projects.slice(0, 5).map((row) => ({
                    name: dimensionLabel(row.name, "project"),
                    value: row.workingMs,
                  }))}
                  emptyLabel="No project activity yet."
                />
              </Card>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Card title="Top models" note="Summed turn duration per model" icon="model">
                {data.models.length === 0 ? (
                  <Empty>No model attribution yet.</Empty>
                ) : (
                  <ul className="divide-border -my-1.5 divide-y">
                    {[...data.models]
                      .sort((a, b) =>
                        Number(isUnknown(a.model)) - Number(isUnknown(b.model)) || b.agentRuntimeMs - a.agentRuntimeMs,
                      )
                      .slice(0, 5)
                      .map((row) => (
                        <li key={`${row.providerId}-${row.model}`} className="flex items-center justify-between gap-3 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <ProviderLogo providerId={row.providerId} />
                            <span className="text-foreground truncate text-[13px] font-medium"
                              data-wk-tooltip={shortModel(row.model)} tabIndex={0}>{shortModel(row.model)}</span>
                            <span className="text-muted-foreground shrink-0 text-[11px] opacity-70"
                              data-wk-tooltip={providerLabel(row.providerId)}>{providerLabel(row.providerId)}</span>
                          </div>
                          <span className="text-foreground shrink-0 text-[13px] font-medium tabular-nums">{formatDuration(row.agentRuntimeMs)}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </Card>

              <Card title="Rhythm" icon="clock">
                <Rows items={[
                  { label: "Typical turn", value: formatDuration(data.pace.medianTurnMs) },
                  { label: "Slowest 10%", value: formatDuration(data.pace.p90TurnMs) },
                  { label: "Turns per hour", value: data.pace.turnsPerActiveHour.toFixed(1) },
                  { label: "Busy share", value: `${Math.min(100, data.pace.coveragePercent).toFixed(0)}%` },
                  { label: "Longest wait", value: formatDuration(data.pace.longestIdleRunwayMs) },
                  { label: "In parallel", value: formatDuration(data.concurrency.swarmTimeMs) },
                  { label: "Busiest day", value: data.streak.busiestDay ? formatDate(data.streak.busiestDay.date) : "—",
                    hint: data.streak.busiestDay ? formatDuration(data.streak.busiestDay.workingMs) : undefined },
                  { label: "Sessions", value: data.quality.sessionCount.toLocaleString() },
                ]} />
              </Card>
            </div>

            {data.machines.length > 0 ? (
              <Card title="Machines" note="Union of active thread time per machine" icon="machine">
                <ul className="flex flex-wrap gap-2">
                  {data.machines.slice(0, 6).map((row) => (
                    <li
                      key={row.name}
                      className="border-border bg-muted flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: "var(--wk-machine-dot)" }}
                      />
                      <span className="text-foreground truncate text-[13px] font-medium"
                        data-wk-tooltip={dimensionLabel(row.name, "machine")} tabIndex={0}>
                        {dimensionLabel(row.name, "machine")}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums opacity-70">
                        {formatDuration(row.workingMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <p className="text-muted-foreground pb-1 text-center text-[11px] opacity-60">
              {data.quality.sampledTurnCount.toLocaleString()} of {data.turnCount.toLocaleString()} turns carry model attribution
              {topModel ? ` · most used ${shortModel(topModel.model)}` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
