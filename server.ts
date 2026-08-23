// bb-plugin-wakatime — time tracking for bb, like WakaTime for IDEs.
//
// Canonical interval model: `sessions` (thread active periods) and `turns`
// (per-turn model attribution) are the source of truth. All aggregates are
// computed from intervals at query time; a crash leaves an open interval
// that reconciliation closes on next load.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const POLL_MS = 10_000;

export const rpcContract = defineRpcContract({
  getSummary: {
    input: z
      .object({
        range: z.enum(["today", "7d", "30d", "all"]),
      })
      .strict(),
    output: z
      .object({
        totalActiveMs: z.number(),
        totalComputeMs: z.number(),
        turnCount: z.number(),
        days: z.array(
          z.object({ date: z.string(), activeMs: z.number(), computeMs: z.number() }),
        ),
        projects: z.array(z.object({ name: z.string(), activeMs: z.number() })),
        machines: z.array(z.object({ name: z.string(), activeMs: z.number() })),
        models: z.array(
          z.object({
            model: z.string(),
            providerId: z.string(),
            computeMs: z.number(),
            turnCount: z.number(),
          }),
        ),
      })
      .strict(),
  },
});

interface OpenSession {
  id: number;
  threadId: string;
  startedAt: number;
}

interface ThreadCursor {
  lastSeq: number;
  openTurnId: string | null;
  openTurnStartedAt: number;
  model: string;
  providerId: string;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      project_id TEXT,
      machine_id TEXT,
      provider_id TEXT,
      model TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_open
       ON sessions(thread_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      session_id INTEGER,
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'unknown',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_unique ON turns(thread_id, turn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at)`,
    `CREATE TABLE IF NOT EXISTS poll_cursors (
      thread_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    )`,
  ]);

  const stmts = {
    openSession: db.prepare(
      `INSERT INTO sessions (thread_id, project_id, machine_id, provider_id, model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    closeSession: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE thread_id = ? AND ended_at IS NULL`,
    ),
    closeSessionById: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`,
    ),
    getOpenSession: db.prepare(
      `SELECT id, thread_id, started_at FROM sessions WHERE thread_id = ? AND ended_at IS NULL`,
    ),
    listOpenSessions: db.prepare(
      `SELECT id, thread_id, started_at FROM sessions WHERE ended_at IS NULL`,
    ),
    insertTurn: db.prepare(
      `INSERT INTO turns (thread_id, turn_id, session_id, provider_id, model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, turn_id) DO NOTHING`,
    ),
    closeTurn: db.prepare(
      `UPDATE turns SET ended_at = ?
         WHERE thread_id = ? AND turn_id = ? AND ended_at IS NULL`,
    ),
    closeOpenTurns: db.prepare(`UPDATE turns SET ended_at = ? WHERE ended_at IS NULL`),
    closeAllOpenSessions: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL`,
    ),
    getCursor: db.prepare(
      `SELECT last_seq FROM poll_cursors WHERE thread_id = ?`,
    ),
    setCursor: db.prepare(
      `INSERT INTO poll_cursors (thread_id, last_seq) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq`,
    ),
    deleteCursor: db.prepare(`DELETE FROM poll_cursors WHERE thread_id = ?`),
    deleteSessionMeta: db.prepare(
      `UPDATE sessions SET project_id = NULL, machine_id = NULL
         WHERE project_id = ? OR machine_id = ?`,
    ),
  };

  const openSessions = new Map<string, OpenSession>();
  const cursors = new Map<string, ThreadCursor>();

  function dimensionName(idOrName: unknown): string {
    return typeof idOrName === "string" && idOrName.length > 0
      ? idOrName
      : "unknown";
  }

  async function snapshotThread(threadId: string) {
    let projectId: string | null = null;
    let hostId: string | null = null;
    let model = "unknown";
    let providerId = "unknown";
    let dtoProvider = "unknown";
    try {
      const t = await bb.sdk.threads.get({ threadId });
      projectId = t.projectId ?? null;
      if (typeof t.providerId === "string" && t.providerId)
        providerId = t.providerId;
      dtoProvider = providerId;
      const envHost =
        (t as { environment?: { hostId?: string } }).environment?.hostId ??
        null;
      if (envHost) {
        hostId = envHost;
      } else if (t.environmentId) {
        try {
          const env = await bb.sdk.environments.get({
            environmentId: t.environmentId,
          });
          hostId = env.hostId ?? null;
        } catch {
          /* leave unknown */
        }
      }
    } catch {
      /* thread gone */
    }
    try {
      const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (opts?.model) model = opts.model;
      if (providerId === "unknown") providerId = dtoProvider;
    } catch {
      /* keep defaults */
    }
    return { projectId, hostId, model, providerId };
  }

  async function markActive(threadId: string) {
    if (openSessions.has(threadId)) return;
    const snap = await snapshotThread(threadId);
    let hostName: string | null = snap.hostId;
    if (snap.hostId) {
      try {
        const h = await bb.sdk.hosts.get({ hostId: snap.hostId });
        hostName = h.name ?? snap.hostId;
      } catch {
        /* keep id */
      }
    }
    const res = stmts.openSession.run(
      threadId,
      snap.projectId,
      hostName,
      snap.providerId,
      snap.model,
      Date.now(),
    );
    openSessions.set(threadId, {
      id: Number(res.lastInsertRowid),
      threadId,
      startedAt: Date.now(),
    });
    // Start polling this thread's events for turn boundaries.
    startPolling(threadId);
  }

  function markInactive(threadId: string) {
    const s = openSessions.get(threadId);
    if (!s) return;
    stmts.closeSession.run(Date.now(), threadId);
    openSessions.delete(threadId);
    stopPolling(threadId);
    finalizeThread(threadId);
  }

  function finalizeThread(threadId: string) {
    // Close any dangling open turn and drop the cursor.
    const c = cursors.get(threadId);
    if (c?.openTurnId) stmts.closeTurn.run(Date.now(), threadId, c.openTurnId);
    cursors.delete(threadId);
    stmts.deleteCursor.run(threadId);
  }

  async function reconcile() {
    // Close sessions for threads that vanished while we were unloaded.
    for (const [threadId, s] of openSessions) {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        if (t.status !== "active") markInactive(threadId);
      } catch {
        stmts.closeSessionById.run(Date.now(), s.id);
        openSessions.delete(threadId);
        finalizeThread(threadId);
      }
    }
    // Discover already-running threads (including hidden/child).
    try {
      let offset = 0;
      for (;;) {
        const rows = await bb.sdk.threads.list({
          limit: 100,
          offset,
          includeHidden: true,
        });
        for (const t of rows) {
          if (t.status === "active") await markActive(t.id);
        }
        offset += rows.length;
        if (rows.length < 100 || offset > 5000) break;
      }
    } catch (err) {
      bb.log.error(`reconcile failed: ${String(err)}`);
    }
    // Orphaned rows: sessions/turns left open with no live thread.
    for (const row of stmts.listOpenSessions.all() as {
      id: number;
      thread_id: string;
    }[]) {
      if (!openSessions.has(row.thread_id)) {
        try {
          await bb.sdk.threads.get({ threadId: row.thread_id });
        } catch {
          stmts.closeSessionById.run(Date.now(), row.id);
        }
      }
    }
  }

  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  function startPolling(threadId: string) {
    if (pollers.has(threadId)) return;
    const timer = setInterval(() => void pollThread(threadId), POLL_MS);
    pollers.set(threadId, timer);
    void pollThread(threadId);
  }

  function stopPolling(threadId: string) {
    const t = pollers.get(threadId);
    if (t) clearInterval(t);
    pollers.delete(threadId);
  }

  async function pollThread(threadId: string) {
    try {
      let cursor = cursors.get(threadId);
      if (!cursor) {
        const row = stmts.getCursor.get(threadId) as
          | { last_seq: number }
          | undefined;
        cursor = {
          lastSeq: row?.last_seq ?? 0,
          openTurnId: null,
          openTurnStartedAt: 0,
          model: "unknown",
          providerId: "unknown",
        };
        // Resume any turn left open by a crash.
        const openTurn = db
          .prepare(
            `SELECT turn_id, started_at FROM turns
               WHERE thread_id = ? AND ended_at IS NULL LIMIT 1`,
          )
          .get(threadId) as { turn_id: string; started_at: number } | undefined;
        if (openTurn) {
          cursor.openTurnId = openTurn.turn_id;
          cursor.openTurnStartedAt = openTurn.started_at;
        }
        cursors.set(threadId, cursor);
      }

      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["turn/started", "turn/completed"],
        order: "asc",
        ...(cursor.lastSeq > 0 ? { afterSeq: String(cursor.lastSeq) } : {}),
      });

      const session = openSessions.get(threadId);
      for (const ev of events) {
        // Skip already-processed sequence numbers (cursor is updated only
        // after the batch, so replay after a crash can overlap).
        if (ev.seq <= cursor.lastSeq) continue;
        cursor.lastSeq = ev.seq;
        if (ev.type === "turn/started") {
          // Events carry no turnId — key intervals by the start event's seq.
          if (cursor.openTurnId) {
            stmts.closeTurn.run(ev.createdAt, threadId, cursor.openTurnId);
          }
          const snap = await snapshotThread(threadId);
          cursor.model = snap.model;
          cursor.providerId = snap.providerId;
          cursor.openTurnId = String(ev.seq);
          cursor.openTurnStartedAt = ev.createdAt ?? Date.now();
          stmts.insertTurn.run(
            threadId,
            cursor.openTurnId,
            session?.id ?? null,
            cursor.providerId,
            cursor.model,
            cursor.openTurnStartedAt,
          );
        } else if (ev.type === "turn/completed") {
          if (!cursor.openTurnId) {
            // Crash mid-turn: recover start time from the stored row.
            const openTurn = db
              .prepare(
                `SELECT turn_id, started_at, session_id FROM turns
                   WHERE thread_id = ? AND ended_at IS NULL LIMIT 1`,
              )
              .get(threadId) as
              | { turn_id: string; started_at: number }
              | undefined;
            if (openTurn) cursor.openTurnId = openTurn.turn_id;
          }
          if (cursor.openTurnId) {
            stmts.closeTurn.run(Date.now(), threadId, cursor.openTurnId);
            cursor.openTurnId = null;
          }
        }
      }
      stmts.setCursor.run(threadId, cursor.lastSeq);
    } catch (err) {
      bb.log.warn(`poll error ${threadId}: ${String(err)}`);
    }
  }

  // ---- lifecycle events -------------------------------------------------
  bb.events.on("thread.active", ({ thread }) => void markActive(thread.id));
  bb.events.on("thread.idle", ({ thread }) => markInactive(thread.id));
  bb.events.on("thread.failed", ({ thread }) => markInactive(thread.id));
  bb.events.on("thread.archived", ({ thread }) => markInactive(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => markInactive(thread.id));

  // ---- aggregation ------------------------------------------------------
  type Interval = { start: number; end: number };

  function rangeStart(range: string): number {
    const now = new Date();
    if (range === "today") {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }
    if (range === "7d") return Date.now() - 7 * 86_400_000;
    if (range === "30d") return Date.now() - 30 * 86_400_000;
    return 0;
  }

  function unionMs(intervals: Interval[], from: number, to: number): number {
    const clipped = intervals
      .map((i) => ({
        start: Math.max(i.start, from),
        end: Math.min(i.end, to),
      }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);
    let total = 0;
    let curStart = -1;
    let curEnd = -1;
    for (const i of clipped) {
      if (curStart < 0) {
        curStart = i.start;
        curEnd = i.end;
      } else if (i.start <= curEnd) {
        curEnd = Math.max(curEnd, i.end);
      } else {
        total += curEnd - curStart;
        curStart = i.start;
        curEnd = i.end;
      }
    }
    if (curStart >= 0) total += curEnd - curStart;
    return total;
  }

  function dayKey(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function computeSummary(range: string) {
    const to = Date.now();
    const from = rangeStart(range);
    const closedOpenEnd = `(COALESCE(ended_at, ${to}))`;

    const sessions = db
      .prepare(
        `SELECT id, thread_id, project_id, machine_id, started_at,
                ${closedOpenEnd} AS ended
           FROM sessions WHERE started_at < ? AND ${closedOpenEnd} > ?`,
      )
      .all(to, from) as {
      id: number;
      thread_id: string;
      project_id: string | null;
      machine_id: string | null;
      started_at: number;
      ended: number;
    }[];

    const allIntervals: Interval[] = sessions.map((s) => ({
      start: s.started_at,
      end: s.ended,
    }));
    const totalActiveMs = unionMs(allIntervals, from, to);

    // Daily buckets: split each interval at local-midnight boundaries.
    const dayMap = new Map<string, Interval[]>();
    for (const i of allIntervals) {
      let cur = Math.max(i.start, from);
      while (cur < Math.min(i.end, to)) {
        const key = dayKey(cur);
        const dayEnd = new Date(
          new Date(cur).setHours(24, 0, 0, 0),
        ).getTime();
        const segEnd = Math.min(i.end, dayEnd, to);
        if (!dayMap.has(key)) dayMap.set(key, []);
        dayMap.get(key)!.push({ start: cur, end: segEnd });
        cur = segEnd;
      }
    }
    const days = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ivs]) => ({
        date,
        activeMs: unionMs(ivs, from, to),
        computeMs: 0, // filled below via turns
      }));

    const computeByDay = new Map<string, number>();
    const turns = db
      .prepare(
        `SELECT provider_id, model, started_at, ${closedOpenEnd} AS ended
           FROM turns WHERE started_at < ? AND ${closedOpenEnd} > ?`,
      )
      .all(to, from) as {
      provider_id: string;
      model: string;
      started_at: number;
      ended: number;
    }[];
    const modelMap = new Map<
      string,
      { model: string; providerId: string; computeMs: number; turnCount: number }
    >();
    let totalComputeMs = 0;
    for (const t of turns) {
      const dur = Math.max(0, Math.min(t.ended, to) - Math.max(t.started_at, from));
      totalComputeMs += dur;
      const key = `${t.provider_id}/${t.model}`;
      const m = modelMap.get(key) ?? {
        model: t.model || "unknown",
        providerId: t.provider_id || "unknown",
        computeMs: 0,
        turnCount: 0,
      };
      m.computeMs += dur;
      m.turnCount += 1;
      modelMap.set(key, m);
      computeByDay.set(dayKey(t.started_at), (computeByDay.get(dayKey(t.started_at)) ?? 0) + dur);
    }
    for (const d of days) d.computeMs = computeByDay.get(d.date) ?? 0;

    const projMap = new Map<string, Interval[]>();
    for (const s of sessions) {
      const name = dimensionName(s.project_id);
      if (!projMap.has(name)) projMap.set(name, []);
      projMap.get(name)!.push({ start: s.started_at, end: s.ended });
    }
    const machMap = new Map<string, Interval[]>();
    for (const s of sessions) {
      const name = dimensionName(s.machine_id);
      if (!machMap.has(name)) machMap.set(name, []);
      machMap.get(name)!.push({ start: s.started_at, end: s.ended });
    }

    const cap = (ms: number) =>
      Math.min(ms, Math.max(0, to - from));

    return {
      totalActiveMs: cap(totalActiveMs),
      totalComputeMs,
      turnCount: turns.length,
      days,
      projects: [...projMap.entries()]
        .map(([name, ivs]) => ({ name, activeMs: cap(sumIvs(ivs, from, to)) }))
        .sort((a, b) => b.activeMs - a.activeMs),
      machines: [...machMap.entries()]
        .map(([name, ivs]) => ({ name, activeMs: cap(sumIvs(ivs, from, to)) }))
        .sort((a, b) => b.activeMs - a.activeMs),
      models: [...modelMap.values()].sort((a, b) => b.computeMs - a.computeMs),
    };
  }

  function sumIvs(intervals: Interval[], from: number, to: number): number {
    let total = 0;
    for (const i of intervals) {
      total += Math.max(0, Math.min(i.end, to) - Math.max(i.start, from));
    }
    return total;
  }

  bb.rpc.register(rpcContract, {
    getSummary({ range }) {
      return computeSummary(range);
    },
  });

  // ---- CLI ----------------------------------------------------------------
  bb.cli.register({
    name: "wakatime",
    summary: "Show bb working-time stats",
    commands: [
      {
        name: "today",
        summary: "Today's working time and top breakdowns",
        usage: "bb wakatime today",
      },
      {
        name: "week",
        summary: "Last 7 days working time and top breakdowns",
        usage: "bb wakatime week",
      },
    ],
    async run(argv) {
      const range = argv[0] === "week" ? "7d" : "today";
      const s = computeSummary(range);
      const fmt = (ms: number) => {
        const mins = Math.round(ms / 60_000);
        const h = Math.floor(mins / 60);
        return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
      };
      const lines = [
        `bb working time (${range}): ${fmt(s.totalActiveMs)} active`,
        `agent compute: ${fmt(s.totalComputeMs)} across ${s.turnCount} turns`,
        "",
        "Top projects:",
        ...s.projects
          .slice(0, 5)
          .map((p) => `  ${p.name}: ${fmt(p.activeMs)}`),
        "Top machines:",
        ...s.machines
          .slice(0, 5)
          .map((m) => `  ${m.name}: ${fmt(m.activeMs)}`),
        "Models:",
        ...s.models
          .slice(0, 5)
          .map((m) => `  ${m.providerId}/${m.model}: ${fmt(m.computeMs)} (${m.turnCount} turns)`),
      ];
      return { exitCode: 0, stdout: lines.join("\n") + "\n" };
    },
  });

  // ---- startup / shutdown ----------------------------------------------
  await reconcile();

  bb.background.service("reconciler", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
        if (signal.aborted) break;
        try {
          await reconcile();
        } catch (err) {
          bb.log.warn(`periodic reconcile failed: ${String(err)}`);
        }
      }
    },
  });

  bb.onDispose(() => {
    for (const t of pollers.values()) clearInterval(t);
    pollers.clear();
    const now = Date.now();
    stmts.closeAllOpenSessions.run(now);
    stmts.closeOpenTurns.run(now);
  });

  bb.log.info("wakatime plugin loaded");
}
