import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import type { rpcContract } from "./server";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ProviderLogo, modelLogoId } from "@/components/provider-logo";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import "./styles.css";

/*
 * Styling rules for this file, learned from an older webview that dropped every
 * Tailwind class whose selector carries a backslash escape:
 *
 *   - No arbitrary-value classes (`text-[44px]`, `size-[15px]`, `w-1/3`) and no
 *     fractional spacing (`gap-1.5`) — those compile to escaped selectors.
 *     The standard scale never escapes.
 *   - Anything whose exact pixel value carries meaning (icon boxes, chart
 *     heights, heatmap cells) is an inline style or an SVG attribute, so it
 *     cannot depend on the stylesheet resolving at all.
 *   - Surfaces come from the shadcn Card primitive rather than a hand-rolled
 *     class string.
 */

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
  profile: { hours: number[]; weekdays: number[] };
  previous: { workingMs: number; agentRuntimeMs: number; turnCount: number } | null;
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

const RANGES: Array<{ key: RangeKey; label: string; blurb: string; priorBlurb: string }> = [
  { key: "today", label: "Today", blurb: "today", priorBlurb: "yesterday" },
  { key: "7d", label: "7 days", blurb: "this week", priorBlurb: "the week before" },
  { key: "30d", label: "30 days", blurb: "this month", priorBlurb: "the month before" },
  { key: "all", label: "All time", blurb: "all time", priorBlurb: "" },
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
  return formatDuration(ms).replace(" ", " ");
}

function formatCount(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return value.toLocaleString();
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

/** "14" -> "2 PM", in whatever clock the viewer's locale uses. */
function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" })
    .format(new Date(2024, 0, 1, hour));
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

type IconName =
  | "bot" | "calendar" | "chart" | "clock" | "cpu" | "flame" | "folder"
  | "gauge" | "layers" | "monitor" | "moon" | "stopwatch" | "turns";

const ICON_PATHS: Record<IconName, ReactNode> = {
  bot: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M10 17h4" /><path d="M2 13v2M22 13v2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  chart: <><path d="M3 21h18" /><rect x="5" y="11" width="3.5" height="7" rx="1" /><rect x="10.25" y="6" width="3.5" height="12" rx="1" /><rect x="15.5" y="14" width="3.5" height="4" rx="1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></>,
  cpu: <><rect x="7" y="7" width="10" height="10" rx="2.5" /><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" /></>,
  flame: <><path d="M12 22c3.6 0 6.5-2.7 6.5-6.3 0-4.2-4-6.4-4.7-10.7-1.9 1.2-3 3-3 5.1-1.3-.6-2-1.9-2-3.4C6.6 8.4 5.5 11 5.5 13.9 5.5 18.5 8.4 22 12 22Z" /></>,
  folder: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.5.7l1 1.1a2 2 0 0 0 1.5.7h5.8A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z" /></>,
  gauge: <><path d="M4 18a9 9 0 1 1 16 0" /><path d="m12 14 4-4" /><circle cx="12" cy="14" r="1.6" /></>,
  layers: <><path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" /><path d="m4 12 8 4.3 8-4.3" /><path d="m4 16.5 8 4.3 8-4.3" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2.5" /><path d="M9 20h6M12 16v4" /></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></>,
  stopwatch: <><circle cx="12" cy="13.5" r="7.5" /><path d="M9.5 2h5M18.6 5.4 20 6.8M12 9.5v4l2.4 2.4" /></>,
  turns: <><path d="M4 9h11a4 4 0 0 1 0 8h-3" /><path d="m8 13-3.5 4L8 21" /><path d="m16 3 3.5 4L16 11" /></>,
};

/**
 * Sized by SVG attributes, not CSS. An icon that loses its class is an icon at
 * the replaced-element default size, which is how a 16px glyph becomes 300px.
 */
function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "none" }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** bb provider id -> brand mark id. Unknown providers render no mark at all. */
function providerLogoId(providerId: string): string | null {
  const key = providerId.trim().toLowerCase();
  if (!key || isUnknown(key)) return null;
  if (key.includes("claude")) return "claude";
  if (key.includes("codex")) return "codex";
  if (key.includes("opencode")) return "opencode";
  if (key.includes("copilot")) return "copilot";
  if (key.includes("cursor")) return "cursor";
  if (key.includes("gemini") || key.includes("google")) return "google";
  if (key === "pi") return "pi";
  return modelLogoId(key);
}

/**
 * Panels enter in reading order. The cascade is capped so the last card is
 * never queued behind a long stagger — the effect is decorative, and a panel
 * opened many times a day cannot afford to feel like it is arriving.
 */
function riseDelay(index: number): CSSProperties {
  return { animationDelay: `${Math.min(index, 8) * 30}ms` };
}

/**
 * Rolls a number to its new value instead of swapping it. Starting from the
 * previous value (not zero) keeps the 30s background refresh from replaying a
 * full count-up every time the total ticks by a minute.
 */
function useCountUp(target: number, duration = 600): number {
  const still = useReducedMotion();
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (still) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      const next = progress === 1 ? target : from + (target - from) * eased;
      fromRef.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, still]);

  return value;
}

/** A meter that counts up from its left edge once, on the panel's entrance beat. */
function GrowBar({ index = 0, className, style }: {
  index?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <div
      className={cn("wk-grow-x", className)}
      style={{ ...style, animationDelay: `${80 + Math.min(index, 8) * 40}ms` }}
    />
  );
}

/* -------------------------------------------------------------- primitives */

/** The shadcn Card with this dashboard's header row on top of it. */
function Panel({ title, note, icon, action, children, className, index = 0 }: {
  title?: string; note?: string; icon?: IconName; action?: ReactNode;
  children: ReactNode; className?: string; index?: number;
}) {
  return (
    <Card style={riseDelay(index)} className={cn("wk-rise flex min-w-0 flex-col p-4", className)}>
      {title ? (
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2
            className="text-foreground flex min-w-0 items-center gap-2 text-sm font-medium"
            data-wk-tooltip={note}
            tabIndex={note ? 0 : undefined}
          >
            {icon ? <Icon name={icon} className="text-muted-foreground" /> : null}
            <span className="truncate">{title}</span>
          </h2>
          {action ? <div style={{ flex: "none" }}>{action}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

/** A caption in a card header — the average, the peak, the count. */
function Caption({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-xs tabular-nums opacity-70">{children}</span>;
}

/**
 * Change against the equal-length window before this one. Deliberately not
 * red/green: working more hours is not self-evidently good or bad, and status
 * colors are reserved for things that actually mean good or bad.
 */
function Delta({ current, previous, blurb }: { current: number; previous: number | null; blurb: string }) {
  if (previous === null || previous <= 0 || current <= 0) return null;
  const percent = ((current - previous) / previous) * 100;
  if (Math.abs(percent) < 1) return <Caption>level with {blurb}</Caption>;
  const up = percent > 0;
  return (
    <span
      className="text-muted-foreground bg-muted flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium tabular-nums"
      style={{ flex: "none" }}
      data-wk-tooltip={`${formatDuration(previous)} ${blurb}`}
      tabIndex={0}
    >
      <svg aria-hidden="true" viewBox="0 0 12 12" width={12} height={12} fill="none"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        style={{ flex: "none" }}>
        {up ? <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5l3 3" /> : <path d="M6 2.5v7M6 9.5l-3-3M6 9.5l3-3" />}
      </svg>
      {Math.abs(percent) >= 999 ? "999+" : Math.abs(percent).toFixed(0)}% vs {blurb}
    </span>
  );
}

/**
 * Averages a long series down to at most `points` buckets. A year of daily
 * values drawn across 56px is noise; the same year in 20 buckets is a shape.
 */
function condense(values: number[], points: number): number[] {
  if (values.length <= points) return values;
  const size = values.length / points;
  return Array.from({ length: points }, (_, index) => {
    const slice = values.slice(Math.floor(index * size), Math.floor((index + 1) * size));
    return slice.length === 0 ? 0 : slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

/** The trend line on a stat tile. */
function Sparkline({ values, maxPoints = 20 }: { values: number[]; maxPoints?: number }) {
  const path = useMemo(() => {
    const series = condense(values, maxPoints);
    if (series.length < 2) return null;
    const max = Math.max(...series, 1);
    const step = 100 / (series.length - 1);
    const points = series.map((value, index) => {
      // 2 units of headroom so the peak is not clipped by the stroke
      const y = 30 - (value / max) * 26 - 2;
      return `${(index * step).toFixed(2)},${y.toFixed(2)}`;
    });
    return { line: `M${points.join("L")}`, area: `M0,30L${points.join("L")}L100,30Z` };
  }, [values, maxPoints]);

  if (!path) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      style={{ flex: "none", width: 44, height: 18, opacity: 0.7 }}
    >
      <path d={path.area} fill="var(--wk-accent)" fillOpacity={0.1} />
      <path
        className="wk-draw"
        pathLength={1}
        d={path.line}
        fill="none"
        stroke="var(--wk-accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ animationDelay: "120ms" }}
      />
    </svg>
  );
}

/** label · value · detail · trend — the stat tile contract. */
function StatTile({ label, value, unit, detail, icon, trend, index = 0 }: {
  label: string; value: string; unit?: string; detail?: ReactNode;
  icon: IconName; trend?: ReactNode; index?: number;
}) {
  return (
    <Card style={riseDelay(index)} className="wk-rise flex min-w-0 flex-col justify-between p-4">
      <p className="text-muted-foreground flex items-center gap-2 truncate text-xs opacity-80">
        <Icon name={icon} size={14} /> {label}
      </p>
      {/* proportional figures: tabular-nums makes a big standalone number look loose */}
      <p className="text-foreground mt-3 flex min-w-0 items-baseline gap-1 text-2xl font-semibold tracking-tight">
        <span className="truncate">{value}</span>
        {unit ? <span className="text-muted-foreground text-sm font-normal">{unit}</span> : null}
      </p>
      <div className="mt-3 flex items-end justify-between gap-2" style={{ minHeight: 18 }}>
        <span className="text-muted-foreground min-w-0 truncate text-xs opacity-70">{detail}</span>
        {trend}
      </div>
    </Card>
  );
}

function Empty({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center py-8 text-center text-xs" style={style}>
      {children}
    </div>
  );
}

/**
 * A ranked list where each row carries its own meter. Not a bar chart, because
 * the labels here are project and agent names: a category axis truncates them,
 * a full-width row does not.
 */
function MeterList({ rows, emptyLabel, total }: {
  rows: Array<{ key: string; name: string; value: number; mark?: ReactNode; rank: number }>;
  emptyLabel: string;
  total: number;
}) {
  if (rows.length === 0) return <Empty>{emptyLabel}</Empty>;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="flex flex-col gap-4">
      {rows.map((row, index) => (
        <li key={row.key} className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {row.mark ?? (
                <span
                  className="text-muted-foreground text-center text-xs tabular-nums opacity-50"
                  style={{ flex: "none", width: 12 }}
                >
                  {row.rank}
                </span>
              )}
              <span className="text-foreground truncate text-sm font-medium"
                data-wk-tooltip={row.name} tabIndex={0}>{row.name}</span>
            </div>
            <div className="flex items-baseline gap-2" style={{ flex: "none" }}>
              <span className="text-foreground text-sm font-medium tabular-nums">
                {formatDuration(row.value)}
              </span>
              {total > 0 ? (
                <span className="text-muted-foreground text-right text-xs tabular-nums opacity-60" style={{ width: 32 }}>
                  {Math.round((row.value / total) * 100)}%
                </span>
              ) : null}
            </div>
          </div>
          <div className="wk-meter-track mt-2 w-full overflow-hidden rounded-full" style={{ height: 6 }}>
            <GrowBar
              index={index}
              className="wk-meter-fill rounded-full"
              style={{ height: "100%", width: `${Math.max(2, (row.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ charts */

/** GitHub-style daily activity heatmap over the trailing 53 weeks. */
const CELL = 10;
const CELL_GAP = 3;
const PITCH = CELL + CELL_GAP;
const WEEKDAY_COL = 30;
const LABEL_GAP = 6;

function ContributionGraph({ days, timezone, index = 0 }: { days: Day[]; timezone: string; index?: number }) {
  const [hoveredCell, setHoveredCell] = useState<{ text: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { weeks, months, thresholds, activeDays } = useMemo(() => {
    const byDate = new Map(days.map((day) => [day.date, day]));

    // End on the current week's Saturday so every column is a whole week.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = today.getTime() + (6 - today.getDay()) * DAY_MS;
    const start = end - (HEATMAP_WEEKS * 7 - 1) * DAY_MS;

    const cells: Array<Array<{ date: string; workingMs: number; turnCount: number; future: boolean }>> = [];
    const monthLabels: Array<{ index: number; label: string }> = [];
    let lastMonth = -1;
    let active = 0;

    for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
      const column = Array.from({ length: 7 }, (_, weekday) => {
        const stamp = start + (week * 7 + weekday) * DAY_MS;
        const date = localDayKey(stamp);
        const day = byDate.get(date);
        if ((day?.workingMs ?? 0) > 0) active += 1;
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
    return { weeks: cells, months: monthLabels, thresholds: [at(0.25), at(0.5), at(0.75)], activeDays: active };
  }, [days]);

  const levelOf = (workingMs: number): number => {
    if (workingMs <= 0) return 0;
    if (workingMs <= thresholds[0]!) return 1;
    if (workingMs <= thresholds[1]!) return 2;
    if (workingMs <= thresholds[2]!) return 3;
    return 4;
  };

  const cellsWidth = HEATMAP_WEEKS * PITCH - CELL_GAP;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
  }, [cellsWidth]);

  const showCellTooltip = (element: HTMLElement, text: string, x?: number, y?: number) => {
    const rect = element.getBoundingClientRect();
    setHoveredCell({
      text,
      x: Math.min(window.innerWidth - 12, Math.max(12, x ?? rect.left + rect.width / 2)),
      y: Math.max(12, y ?? rect.top),
    });
  };

  return (
    <Panel
      index={index}
      title="Activity graph"
      note={`Daily working time · ${timezone}`}
      icon="calendar"
      action={
        <span className="text-muted-foreground flex items-center gap-1 text-xs opacity-70">
          less
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: `var(--wk-l${level})` }}
            />
          ))}
          more
        </span>
      }
    >
      <p className="text-muted-foreground mb-3 text-xs opacity-70">{activeDays} active days this year</p>
      <div className="flex">
        {/* Weekday gutter lives outside the scroller: inside it, scrolling to
            the most recent week slid these labels out of view. */}
        <div style={{ flex: "none", width: WEEKDAY_COL, paddingRight: LABEL_GAP }}>
          <div style={{ height: 14, marginBottom: CELL_GAP }} aria-hidden="true" />
          <div className="grid" style={{ gridTemplateRows: `repeat(7, ${CELL}px)`, rowGap: CELL_GAP }}>
            {["", "Mon", "", "Wed", "", "Fri", ""].map((label, cellIndex) => (
              <span
                key={cellIndex}
                className="text-muted-foreground text-right opacity-70"
                style={{ fontSize: 10, lineHeight: `${CELL}px` }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto"
          aria-label="Daily working time for the trailing year"
        >
          <div style={{ width: cellsWidth }}>
            {/* month row: absolutely placed so each label sits over its own column */}
            <div className="relative" style={{ height: 14, marginBottom: CELL_GAP }}>
              {months.map((month) => (
                <span key={`${month.label}-${month.index}`}
                  className="text-muted-foreground absolute top-0 opacity-70"
                  style={{ left: month.index * PITCH, fontSize: 10, lineHeight: "14px" }}>
                  {month.label}
                </span>
              ))}
            </div>

            <div
              className="grid"
              style={{
                gridAutoFlow: "column",
                gridTemplateRows: `repeat(7, ${CELL}px)`,
                gridAutoColumns: `${CELL}px`,
                columnGap: CELL_GAP,
                rowGap: CELL_GAP,
              }}
            >
              {weeks.flatMap((column, weekIndex) =>
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
                      className="wk-heat-cell"
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 2,
                        backgroundColor: `var(--wk-l${levelOf(cell.workingMs)})`,
                        // the year fills in left to right, a column at a time
                        animationDelay: `${weekIndex * 7}ms`,
                      }}
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
    </Panel>
  );
}

/** Daily working time. Bars, not an area — one day is still a readable chart. */
function DailyChart({ days, height }: { days: Day[]; height: number }) {
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
    return <Empty style={{ height }}>Nothing tracked in this range yet.</Empty>;
  }

  return (
    <div style={{ height, width: "100%" }}>
      <EvilBarChart
        data={data}
        config={barConfig}
        barRadius={4}
        barCategoryGap={data.length > 14 ? 2 : 8}
        className="aspect-auto h-full w-full"
        xDataKey="label"
      >
        {/* solid hairline: a dashed grid reads as a threshold when it is just a grid */}
        <EvilBarChart.Grid strokeDasharray="0" />
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
          width={42}
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
        <EvilBarChart.Bar dataKey="value" variant="default" radius={4} barProps={{ maxBarSize: 24 }} />
      </EvilBarChart>
    </div>
  );
}

const PLOT_HEIGHT = 96;

/**
 * Working time by local hour of day — the shape of a working day, which no
 * daily total can show. Hand-built rather than charted so each column can own
 * a full-height hit target above a bar that may only be a few pixels tall.
 */
function HourProfile({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1);
  const total = hours.reduce((sum, value) => sum + value, 0);
  const peak = hours.indexOf(max);

  if (total <= 0) return <Empty style={{ height: PLOT_HEIGHT + 32 }}>No hourly pattern yet.</Empty>;

  return (
    <div>
      <div className="flex items-end" style={{ height: PLOT_HEIGHT, gap: 2 }}>
        {hours.map((value, hour) => (
          <div
            key={hour}
            tabIndex={0}
            className="wk-hour-col flex h-full min-w-0 flex-1 flex-col justify-end"
            style={{ cursor: "default" }}
            data-wk-tooltip={`${formatHour(hour)} – ${formatHour((hour + 1) % 24)} · ${formatDuration(value)}`}
          >
            <div
              className="wk-hour-bar wk-grow-y w-full"
              style={{
                height: value > 0 ? Math.max(3, (value / max) * PLOT_HEIGHT) : 2,
                borderRadius: "3px 3px 0 0",
                backgroundColor: value > 0
                  ? (hour === peak ? "var(--wk-accent-ink)" : "var(--wk-accent)")
                  : "var(--wk-track)",
                transition: "background-color 150ms ease-out",
                animationDelay: `${100 + hour * 12}ms`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mt-2 flex justify-between opacity-70" style={{ fontSize: 10 }}>
        {[0, 6, 12, 18].map((hour) => <span key={hour}>{formatHour(hour)}</span>)}
        <span>{formatHour(23)}</span>
      </div>
    </div>
  );
}

/**
 * How much of the working time ran one agent versus several. An ordered bucket
 * scale, so it takes the one-hue ordinal ramp rather than categorical hues.
 */
function SwarmBar({ distribution }: { distribution: Array<{ concurrentTurns: number; durationMs: number }> }) {
  const buckets = useMemo(() => {
    const rows = [0, 0, 0, 0];
    for (const entry of distribution) {
      if (entry.concurrentTurns <= 0) continue;
      rows[Math.min(3, entry.concurrentTurns - 1)]! += entry.durationMs;
    }
    return rows.map((durationMs, index) => ({
      label: index === 3 ? "4+ agents" : index === 0 ? "1 agent" : `${index + 1} agents`,
      durationMs,
      level: index + 1,
    }));
  }, [distribution]);

  const total = buckets.reduce((sum, bucket) => sum + bucket.durationMs, 0);
  const shown = buckets.filter((bucket) => bucket.durationMs > 0);
  if (total <= 0 || shown.length === 0) return <Empty>No overlapping turns yet.</Empty>;

  return (
    <div>
      {/* the 2px gaps are the card surface showing through — no strokes on the marks */}
      <div className="bg-card flex w-full overflow-hidden" style={{ height: 10, gap: 2, borderRadius: 6 }}>
        {shown.map((bucket, index) => (
          <GrowBar
            key={bucket.label}
            index={index}
            style={{
              height: "100%",
              width: `${(bucket.durationMs / total) * 100}%`,
              backgroundColor: `var(--wk-l${bucket.level})`,
              borderTopLeftRadius: index === 0 ? 6 : 0,
              borderBottomLeftRadius: index === 0 ? 6 : 0,
              borderTopRightRadius: index === shown.length - 1 ? 6 : 0,
              borderBottomRightRadius: index === shown.length - 1 ? 6 : 0,
            }}
          />
        ))}
      </div>
      <dl className="mt-4 flex flex-col gap-2">
        {shown.map((bucket) => (
          <div key={bucket.label} className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
              <span aria-hidden="true"
                style={{ flex: "none", width: 10, height: 10, borderRadius: 3, backgroundColor: `var(--wk-l${bucket.level})` }} />
              <span className="truncate">{bucket.label}</span>
            </dt>
            <dd className="flex items-baseline gap-2" style={{ flex: "none" }}>
              <span className="text-foreground text-xs font-medium tabular-nums">
                {formatDuration(bucket.durationMs)}
              </span>
              <span className="text-muted-foreground text-right text-xs tabular-nums opacity-60" style={{ width: 32 }}>
                {Math.round((bucket.durationMs / total) * 100)}%
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Rows({ items }: { items: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground truncate text-xs opacity-70" data-wk-tooltip={item.label}>{item.label}</dt>
          <dd className="text-foreground mt-2 truncate text-sm font-medium tabular-nums">
            {item.value}
            {item.hint ? <span className="text-muted-foreground ml-1 text-xs font-normal opacity-70">{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading bb activity</span>
      <div className="bg-muted animate-pulse rounded-lg" style={{ height: 216 }} />
      <div className="wk-grid wk-tiles">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="bg-muted animate-pulse rounded-lg" style={{ height: 104 }} key={index} />
        ))}
      </div>
      <div className="bg-muted animate-pulse rounded-lg" style={{ height: 160 }} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "time", title: "WakaTime", icon: "Clock", path: "time", component: Dashboard });
});

function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  // Held in a ref so `load` keeps one identity for the life of the panel. A
  // `load` that changes every render re-fires the effect below on every render,
  // which polls in a loop and never leaves the refreshing state.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<Summary | null>(null);
  const [history, setHistory] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async (nextRange: RangeKey, initial = false) => {
    const generation = ++requestGeneration.current;
    // Only the very first load shows skeletons; the 30s poll must not dim or
    // remount anything, so it neither sets `loading` nor `refreshing`.
    if (initial) setLoading(true);
    try {
      // The heatmap always shows the trailing year, whatever range is selected.
      const [summary, allTime] = await Promise.all([
        rpcRef.current.call("getSummary", { range: nextRange }),
        nextRange === "all" ? null : rpcRef.current.call("getSummary", { range: "all" }),
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
  }, []);

  useEffect(() => {
    void load(range, true);
    const timer = setInterval(() => void load(range), 30_000);
    return () => clearInterval(timer);
  }, [range, load]);

  // Switching range holds the previous render at reduced opacity rather than
  // dropping back to skeletons — no layout jump, no flash.
  const changeRange = (nextRange: RangeKey) => {
    if (nextRange === range) return;
    requestGeneration.current += 1;
    setRange(nextRange);
    setError(null);
    setRefreshing(true);
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
        unattributed: entry.unattributed,
      }))
      .sort((a, b) => Number(a.unattributed) - Number(b.unattributed) || b.value - a.value);
  }, [data]);

  const topModel = useMemo(() => {
    if (!data || data.models.length === 0) return null;
    return [...data.models]
      .filter((row) => !isUnknown(row.model))
      .sort((a, b) => b.agentRuntimeMs - a.agentRuntimeMs)[0] ?? null;
  }, [data]);

  const option = RANGES.find((entry) => entry.key === range);
  const rangeBlurb = option?.blurb ?? "";
  const priorBlurb = option?.priorBlurb ?? "";
  const counted = useCountUp(data?.workingMs ?? 0);
  const heroParts = splitDuration(counted);
  const agentTotal = agents.reduce((sum, agent) => sum + agent.value, 0);
  const projectTotal = data?.projects.reduce((sum, project) => sum + project.workingMs, 0) ?? 0;
  const activeDays = data?.days.filter((day) => day.workingMs > 0).length ?? 0;
  const live = (data?.quality.openSessionCount ?? 0) > 0;

  return (
    <main className="h-full overflow-y-auto" data-wk-root>
      <div className="wk-dashboard-shell flex w-full flex-col gap-3 p-4">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex items-center justify-center rounded-lg border"
              style={{
                flex: "none",
                width: 32,
                height: 32,
                borderColor: "var(--wk-accent-edge)",
                backgroundColor: "var(--wk-accent-wash)",
                color: "var(--wk-accent)",
              }}
            >
              <Icon name="stopwatch" size={18} />
            </span>
            <div className="min-w-0">
              <h1 className="text-foreground truncate font-semibold tracking-tight" style={{ fontSize: 15, lineHeight: "20px" }}>
                Activity
              </h1>
              <p className="text-muted-foreground flex items-center gap-2 truncate text-xs opacity-75">
                {live ? (
                  <>
                    <span className="relative flex" style={{ flex: "none", width: 6, height: 6 }}>
                      <span className="wk-live absolute inset-0 rounded-full" />
                      <span className="rounded-full" style={{ width: 6, height: 6, backgroundColor: "var(--wk-accent)" }} />
                    </span>
                    Tracking now
                  </>
                ) : (
                  "Local only"
                )}
                {data ? ` · ${data.range.timezone}` : ""}
              </p>
            </div>
          </div>
          <SegmentedControl
            label="Date range"
            value={range}
            onChange={changeRange}
            options={RANGES.map((entry) => ({ value: entry.key, label: entry.label }))}
          />
        </header>

        {loading && !data ? <LoadingState /> : null}

        {error && !data ? (
          <Card className="flex items-center justify-between gap-4 p-4" role="alert">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Could not load activity</p>
              <p className="text-muted-foreground mt-1 truncate text-xs">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void load(range, true)}
              className="border-border hover:bg-muted rounded-lg border px-3 py-2 text-xs transition-colors duration-150 ease-out active:scale-95"
              style={{ flex: "none" }}
            >
              Retry
            </button>
          </Card>
        ) : null}

        {data ? (
          <div
            className="flex flex-col gap-3"
            aria-busy={refreshing}
            style={{ opacity: refreshing ? 0.55 : 1, transition: "opacity 200ms ease-out" }}
          >
            {error ? (
              <div className="border-border bg-muted text-muted-foreground flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs" role="status">
                <span className="truncate">Showing the last good data — refresh failed.</span>
                <button type="button" onClick={() => void load(range)} className="text-foreground underline underline-offset-2" style={{ flex: "none" }}>
                  Retry
                </button>
              </div>
            ) : null}

            {/* Headline figure and the daily series share one panel: the number
                is the sum of the bars beside it, so splitting them across two
                cards left the reader to join them up. */}
            <Card style={riseDelay(0)} className="wk-rise wk-hero min-w-0 p-4">
              <div className="wk-grid wk-hero-grid">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs opacity-80">bb worked {rangeBlurb}</p>
                  {/* the one hero figure on the page: proportional figures, not tabular */}
                  <p className="text-foreground mt-3 flex items-baseline gap-2 text-5xl font-semibold tracking-tight">
                    {heroParts.map((part) => (
                      <span key={part.unit}>
                        {part.value}
                        <span className="text-muted-foreground text-xl font-normal">{part.unit}</span>
                      </span>
                    ))}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Delta current={data.workingMs} previous={data.previous?.workingMs ?? null} blurb={priorBlurb} />
                  </div>
                  <p className="text-muted-foreground mt-3 text-xs opacity-80">
                    <span className="text-foreground font-medium">{formatCount(data.turnCount)}</span> turns ·{" "}
                    <span className="text-foreground font-medium">{data.projects.length}</span>{" "}
                    project{data.projects.length === 1 ? "" : "s"} ·{" "}
                    <span className="text-foreground font-medium">{activeDays}</span> active day{activeDays === 1 ? "" : "s"}
                  </p>
                </div>

                {/* A single-day range would draw a one-bar bar chart; the hero
                    figure already is that number. */}
                {data.days.length > 1 ? (
                  <div className="wk-hero-chart min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs opacity-70">Daily activity</span>
                      {activeDays > 0 ? (
                        <Caption>{formatDuration(data.workingMs / activeDays)} per active day</Caption>
                      ) : null}
                    </div>
                    <DailyChart days={data.days} height={168} />
                  </div>
                ) : null}
              </div>
            </Card>

            <section className="wk-grid wk-tiles" aria-label="Highlights">
              <StatTile
                index={1}
                label="Agent time"
                icon="clock"
                value={formatDuration(data.agentRuntimeMs)}
                detail={data.agentRuntimeMs > data.workingMs ? "beats the clock" : "summed turn time"}
                trend={<Sparkline values={data.days.map((day) => day.agentRuntimeMs)} />}
              />
              <StatTile
                index={2}
                label="Turns"
                icon="turns"
                value={formatCount(data.turnCount)}
                detail={`${data.pace.turnsPerActiveHour.toFixed(1)} per hour`}
                trend={<Sparkline values={data.days.map((day) => day.turnCount)} />}
              />
              <StatTile
                index={3}
                label="Peak swarm"
                icon="layers"
                value={String(data.concurrency.peakConcurrentTurns)}
                unit="at once"
                detail={`${data.concurrency.averageConcurrentTurns.toFixed(1)}× average`}
                trend={<Sparkline values={data.days.map((day) => day.peakConcurrentTurns)} />}
              />
              <StatTile
                index={4}
                label="Streak"
                icon="flame"
                value={String(data.streak.currentDays)}
                unit={data.streak.currentDays === 1 ? "day" : "days"}
                detail={`best run ${data.streak.longestDays} days`}
              />
            </section>

            {history ? (
              <ContributionGraph index={5} days={history.days} timezone={data.range.timezone} />
            ) : null}

            <div className="wk-grid wk-duo">
              <Panel
                index={6}
                title="When you work"
                note="Working time by hour of the day, in your server's timezone"
                icon="moon"
                action={Math.max(...data.profile.hours) > 0 ? (
                  <Caption>peak {formatHour(data.profile.hours.indexOf(Math.max(...data.profile.hours)))}</Caption>
                ) : null}
              >
                <HourProfile hours={data.profile.hours} />
              </Panel>
              <Panel
                index={7}
                title="Swarm"
                note="Share of turn time by how many agents ran at once"
                icon="layers"
                action={<Caption>{formatDuration(data.concurrency.swarmTimeMs)} in parallel</Caption>}
              >
                <SwarmBar distribution={data.concurrency.distribution} />
              </Panel>
            </div>

            <div className="wk-grid wk-duo">
              <Panel index={8} title="Agents" note="Summed turn duration per provider" icon="bot">
                <MeterList
                  total={agentTotal}
                  rows={agents.slice(0, 5).map((agent, index) => ({
                    key: agent.name,
                    name: agent.name,
                    value: agent.value,
                    rank: index + 1,
                    mark: <ProviderLogo id={providerLogoId(agent.providerId)} size="sm" />,
                  }))}
                  emptyLabel="No agent turns attributed yet."
                />
              </Panel>
              <Panel index={9} title="Projects" note="Union of active thread time per project" icon="folder">
                <MeterList
                  total={projectTotal}
                  rows={data.projects.slice(0, 5).map((row, index) => ({
                    key: row.name,
                    name: dimensionLabel(row.name, "project"),
                    value: row.workingMs,
                    rank: index + 1,
                  }))}
                  emptyLabel="No project activity yet."
                />
              </Panel>
            </div>

            <div className="wk-grid wk-duo">
              <Panel index={10} title="Models" note="Summed turn duration per model" icon="cpu">
                {data.models.length === 0 ? (
                  <Empty>No model attribution yet.</Empty>
                ) : (
                  <ul className="divide-border flex flex-col divide-y">
                    {[...data.models]
                      .sort((a, b) =>
                        Number(isUnknown(a.model)) - Number(isUnknown(b.model)) || b.agentRuntimeMs - a.agentRuntimeMs,
                      )
                      .slice(0, 5)
                      .map((row) => (
                        <li key={`${row.providerId}-${row.model}`} className="flex items-center justify-between gap-3 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <ProviderLogo id={modelLogoId(row.model) ?? providerLogoId(row.providerId)} size="sm" />
                            <span className="text-foreground truncate text-sm font-medium"
                              data-wk-tooltip={shortModel(row.model)} tabIndex={0}>{shortModel(row.model)}</span>
                            <span className="text-muted-foreground text-xs opacity-70" style={{ flex: "none" }}>
                              {providerLabel(row.providerId)}
                            </span>
                          </div>
                          <div className="flex items-baseline gap-2" style={{ flex: "none" }}>
                            <span className="text-foreground text-sm font-medium tabular-nums">
                              {formatDuration(row.agentRuntimeMs)}
                            </span>
                            <span className="text-muted-foreground text-right text-xs tabular-nums opacity-60"
                              style={{ whiteSpace: "nowrap" }}>
                              {formatCount(row.turnCount)} turns
                            </span>
                          </div>
                        </li>
                      ))}
                  </ul>
                )}
              </Panel>

              <Panel index={11} title="Rhythm" note="Turn pacing across the range" icon="gauge">
                <Rows items={[
                  { label: "Typical turn", value: formatDuration(data.pace.medianTurnMs) },
                  { label: "Slowest 10%", value: formatDuration(data.pace.p90TurnMs) },
                  { label: "Turns per hour", value: data.pace.turnsPerActiveHour.toFixed(1) },
                  { label: "Busy share", value: `${Math.min(100, data.pace.coveragePercent).toFixed(0)}%` },
                  { label: "Longest wait", value: formatDuration(data.pace.longestIdleRunwayMs) },
                  { label: "Sessions", value: data.quality.sessionCount.toLocaleString() },
                  { label: "Busiest day", value: data.streak.busiestDay ? formatDate(data.streak.busiestDay.date) : "—",
                    hint: data.streak.busiestDay ? formatDuration(data.streak.busiestDay.workingMs) : undefined },
                  { label: "Best streak", value: `${data.streak.longestDays}`, hint: "days" },
                ]} />
              </Panel>
            </div>

            {data.machines.length > 0 ? (
              <Panel index={12} title="Machines" note="Union of active thread time per machine" icon="monitor">
                <ul className="flex flex-wrap gap-2">
                  {data.machines.slice(0, 6).map((row) => (
                    <li
                      key={row.name}
                      className="border-border bg-muted flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"
                    >
                      <span
                        aria-hidden="true"
                        className="rounded-full"
                        style={{ flex: "none", width: 6, height: 6, backgroundColor: "var(--wk-machine-dot)" }}
                      />
                      <span className="text-foreground truncate text-sm font-medium"
                        data-wk-tooltip={dimensionLabel(row.name, "machine")} tabIndex={0}>
                        {dimensionLabel(row.name, "machine")}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums opacity-70" style={{ flex: "none" }}>
                        {formatDuration(row.workingMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <p className="text-muted-foreground text-center text-xs opacity-60">
              {formatCount(data.quality.sampledTurnCount)} of {formatCount(data.turnCount)} turns carry model attribution
              {topModel ? ` · most used ${shortModel(topModel.model)}` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
