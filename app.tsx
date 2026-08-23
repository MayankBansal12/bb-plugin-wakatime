import {
  definePluginApp,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { rpcContract } from "./server";

type Summary = {
  totalActiveMs: number;
  totalComputeMs: number;
  turnCount: number;
  days: { date: string; activeMs: number; computeMs: number }[];
  projects: { name: string; activeMs: number }[];
  machines: { name: string; activeMs: number }[];
  models: {
    model: string;
    providerId: string;
    computeMs: number;
    turnCount: number;
  }[];
};

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
] as const;

function BarChart({ days }: { days: { date: string; activeMs: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.activeMs));
  return (
    <div className="flex items-end gap-1.5 h-32">
      {days.map((d) => (
        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <div
            className="w-full rounded-t bg-blue-500/80 hover:bg-blue-400 transition-colors"
            style={{ height: `${Math.max(2, (d.activeMs / max) * 100)}%` }}
            title={`${d.date}: ${fmtMs(d.activeMs)}`}
          />
          <span className="text-[10px] text-muted-foreground truncate w-full text-center">
            {d.date.slice(5)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground mt-0.5">{sub}</div> : null}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; value: string; pct: number }[];
}) {
  if (rows.length === 0)
    return (
      <div className="rounded-lg border p-4">
        <div className="text-sm font-medium mb-2">{title}</div>
        <div className="text-sm text-muted-foreground">No data yet</div>
      </div>
    );
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm font-medium mb-3">{title}</div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.name}>
            <div className="flex justify-between text-sm">
              <span className="truncate max-w-[60%]">{r.name}</span>
              <span className="text-muted-foreground tabular-nums">{r.value}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500/70"
                style={{ width: `${Math.min(100, r.pct)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "time",
    title: "Time",
    icon: "Clock",
    path: "time",
    component: Dashboard,
  });
});

function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("today");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const s = await rpc.call("getSummary", { range });
        if (alive) {
          setData(s);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(String(err));
      }
    }
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rpc, range]);

  if (error)
    return <div className="p-6 text-sm text-red-500">Failed to load stats: {error}</div>;
  if (!data)
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const parallelism =
    data.totalActiveMs > 0 ? data.totalComputeMs / data.totalActiveMs : 0;
  const topProject = data.projects[0];
  const topModel = data.models[0];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
      <div className="flex gap-1 rounded-lg border p-1 w-fit">
        {RANGES.map((r) => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              range === r.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Working time" value={fmtMs(data.totalActiveMs)} />
        <Stat
          label="Agent compute"
          value={fmtMs(data.totalComputeMs)}
          sub={`${parallelism.toFixed(1)}× parallelism`}
        />
        <Stat label="Turns" value={String(data.turnCount)} />
        <Stat
          label="Top model"
          value={topModel ? topModel.model.split("/").pop() ?? "?" : "—"}
          sub={topModel ? fmtMs(topModel.computeMs) : undefined}
        />
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm font-medium mb-4">Daily working time</div>
        {data.days.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No activity in this range yet — run a thread and come back.
          </div>
        ) : (
          <BarChart days={data.days} />
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <BreakdownTable
          title="By project"
          rows={data.projects.map((p) => ({
            name: p.name,
            value: fmtMs(p.activeMs),
            pct:
              data.totalComputeMs > 0 || data.totalActiveMs > 0
                ? (p.activeMs / Math.max(1, data.totalActiveMs)) * 100
                : 0,
          }))}
        />
        <BreakdownTable
          title="By machine"
          rows={data.machines.map((m) => ({
            name: m.name,
            value: fmtMs(m.activeMs),
            pct: (m.activeMs / Math.max(1, data.totalActiveMs)) * 100,
          }))}
        />
      </div>

      <BreakdownTable
        title="Models"
        rows={data.models.map((m) => ({
          name: `${m.providerId} · ${m.model}`,
          value: `${fmtMs(m.computeMs)} · ${m.turnCount} turns`,
          pct:
            data.totalComputeMs > 0
              ? (m.computeMs / data.totalComputeMs) * 100
              : 0,
        }))}
      />

      {topProject ? (
        <div className="text-xs text-muted-foreground">
          Most of this period went to{" "}
          <span className="font-medium">{topProject.name}</span>
          {data.machines[0] ? <> on {data.machines[0].name}</> : null}. Your agents ran at{" "}
          <span className="font-medium">{parallelism.toFixed(1)}×</span> parallelism.
        </div>
      ) : null}
    </div>
  );
}
