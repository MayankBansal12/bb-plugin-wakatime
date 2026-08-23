// bb-plugin-wakatime — time tracking for bb, like WakaTime for IDEs.
//
// Canonical interval model: `sessions` (thread active periods) and `turns`
// (per-turn model attribution) are the source of truth. All aggregates are
// computed from intervals at query time; a crash leaves an open interval
// that startup reconciliation adopts or closes.
//
// Concurrency: every mutation for a thread runs through a per-thread mutex,
// so activate/deactivate/poll never interleave. Polling drains events and
// commits cursor + interval changes together; one poll per thread at a time.
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
}

export default async function plugin(bb: BbPluginApi) {
  const processStart = Date.now();
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      project_name TEXT,
      machine_name TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at)`,
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
    `CREATE INDEX IF NOT EXISTS idx_turns_open ON turns(thread_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS poll_cursors (
      thread_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    )`,
  ]);

  // One-off migration from the v0.1 schema (project_id/machine_id columns).
  {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as {
      name: string;
    }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "project_name")) {
      db.transaction(() => {
        // Indexes follow the renamed table — drop them first so they can be
        // recreated against the new table.
        db.exec(
          `DROP INDEX IF EXISTS idx_sessions_started;
           DROP INDEX IF EXISTS idx_sessions_ended;
           DROP INDEX IF EXISTS idx_sessions_open;
           ALTER TABLE sessions RENAME TO sessions_v01;
           CREATE TABLE sessions (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             thread_id TEXT NOT NULL,
             project_name TEXT,
             machine_name TEXT,
             started_at INTEGER NOT NULL,
             ended_at INTEGER
           );`,
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
           CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);
           CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_open
             ON sessions(thread_id) WHERE ended_at IS NULL;
           INSERT INTO sessions (thread_id, started_at, ended_at)
             SELECT thread_id, started_at, ended_at FROM sessions_v01 WHERE ended_at IS NOT NULL;
           DROP TABLE sessions_v01;`,
        );
      })();
      bb.log.info("migrated v0.1 sessions table");
    }
  }

  const stmts = {
    openSession: db.prepare(
      `INSERT INTO sessions (thread_id, project_name, machine_name, started_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) WHERE ended_at IS NULL DO NOTHING`,
    ),
    closeSessionByThread: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE thread_id = ? AND ended_at IS NULL`,
    ),
    closeSessionById: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`,
    ),
    listOpenSessions: db.prepare(
      `SELECT id, thread_id, started_at FROM sessions WHERE ended_at IS NULL`,
    ),
    insertTurn: db.prepare(
      `INSERT INTO turns (thread_id, turn_id, session_id, provider_id, model, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, turn_id) DO NOTHING`,
    ),
    closeOpenTurnsForThread: db.prepare(
      `UPDATE turns SET ended_at = ?
         WHERE thread_id = ? AND ended_at IS NULL AND started_at < ?`,
    ),
    closeAllOpenSessions: db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL`,
    ),
    closeAllOpenTurns: db.prepare(
      `UPDATE turns SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?`,
    ),
    getCursor: db.prepare(`SELECT last_seq FROM poll_cursors WHERE thread_id = ?`),
    setCursor: db.prepare(
      `INSERT INTO poll_cursors (thread_id, last_seq) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq`,
    ),
    deleteCursor: db.prepare(`DELETE FROM poll_cursors WHERE thread_id = ?`),
  };

  interface SessionMeta {
    projectName: string | null;
    machineName: string | null;
  }
  const sessionMeta = new Map<number, SessionMeta>();
  const openSessions = new Map<string, OpenSession>();
  const cursors = new Map<string, ThreadCursor>();
  const locks = new Map<string, Promise<void>>();
  const polling = new Set<string>();

  /** Serialize all mutations for one thread. */
  function withLock(threadId: string, fn: () => Promise<unknown>): Promise<void> {
    const prev = locks.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn).then(
      () => undefined,
      () => undefined,
    );
    locks.set(threadId, next);
    return next;
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  async function snapshotThread(threadId: string) {
    let projectId: string | null = null;
    let hostId: string | null = null;
    let model = "unknown";
    let providerId = "unknown";
    try {
      const t = await bb.sdk.threads.get({ threadId });
      projectId = t.projectId ?? null;
      if (typeof t.providerId === "string" && t.providerId)
        providerId = t.providerId;
      const envHost =
        (t as { environment?: { hostId?: string } }).environment?.hostId ?? null;
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
    } catch {
      /* keep defaults */
    }
    let projectName: string | null = null;
    if (projectId) {
      try {
        const p = await bb.sdk.projects.get({ projectId });
        projectName = p.name ?? projectId;
      } catch {
        try {
          const all = await bb.sdk.projects.list({ includePersonal: true });
          const hit = all.find((x) => x.id === projectId);
          projectName = hit?.name ?? projectId;
        } catch {
          projectName = projectId;
        }
      }
    }
    let machineName: string | null = null;
    if (hostId) {
      try {
        const h = await bb.sdk.hosts.get({ hostId });
        machineName = h.name ?? hostId;
      } catch {
        machineName = hostId;
      }
    }
    return { projectName, machineName, model, providerId };
  }

  /**
   * Open a session for a thread. `at` is the lifecycle timestamp captured at
   * event time so slow SDK lookups don't shift the interval start.
   */
  async function markActive(threadId: string, at: number) {
    await withLock(threadId, async () => {
      if (openSessions.has(threadId)) return;
      const meta = await snapshotThread(threadId);
      if (openSessions.has(threadId)) return; // re-check under lock
      const res = stmts.openSession.run(
        threadId,
        meta.projectName,
        meta.machineName,
        at,
      );
      if (res.changes === 0) {
        // An open row already exists (crash recovery didn't reach us yet).
        const row = db
          .prepare(
            `SELECT id, started_at FROM sessions WHERE thread_id = ? AND ended_at IS NULL`,
          )
          .get(threadId) as { id: number; started_at: number } | undefined;
        if (row)
          openSessions.set(threadId, {
            id: row.id,
            threadId,
            startedAt: row.started_at,
          });
        return;
      }
      openSessions.set(threadId, {
        id: Number(res.lastInsertRowid),
        threadId,
        startedAt: at,
      });
      startPolling(threadId);
    });
  }

  function markInactive(threadId: string, at: number) {
    return withLock(threadId, async () => {
      if (!openSessions.has(threadId)) return;
      // Final drain so turns completed since the last poll are not lost.
      await drainEvents(threadId);
      stmts.closeSessionByThread.run(at, threadId);
      openSessions.delete(threadId);
      stopPolling(threadId);
      // Cursor is retained durably so reactivation doesn't replay history.
    });
  }

  function forgetThread(threadId: string) {
    return withLock(threadId, async () => {
      await drainEvents(threadId);
      stmts.closeSessionByThread.run(Date.now(), threadId);
      openSessions.delete(threadId);
      stopPolling(threadId);
      cursors.delete(threadId);
      stmts.deleteCursor.run(threadId);
    });
  }

  // ---- event polling -----------------------------------------------------
  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  function startPolling(threadId: string) {
    if (pollers.has(threadId)) return;
    const timer = setInterval(() => {
      void withLock(threadId, () => drainEvents(threadId));
    }, POLL_MS);
    pollers.set(threadId, timer);
  }

  function stopPolling(threadId: string) {
    const t = pollers.get(threadId);
    if (t) clearInterval(t);
    pollers.delete(threadId);
  }

  /**
   * Drain new thread events and record turn intervals. Runs under the thread
   * lock; guarded against overlapping execution from reconcile paths.
   */
  async function drainEvents(threadId: string) {
    if (polling.has(threadId)) return;
    polling.add(threadId);
    try {
      let cursor = cursors.get(threadId);
      if (!cursor) {
        const row = stmts.getCursor.get(threadId) as
          | { last_seq: number }
          | undefined;
        cursor = { lastSeq: row?.last_seq ?? 0, openTurnId: null, openTurnStartedAt: 0 };
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
        if (ev.seq <= cursor.lastSeq) continue;
        cursor.lastSeq = ev.seq;
        const completedAt = Math.max(ev.createdAt, cursor.openTurnStartedAt);
        const scope = ev.scope as
          | { kind: string; turnId?: string }
          | undefined;
        const evTurnId =
          scope?.kind === "turn" && typeof scope.turnId === "string"
            ? scope.turnId
            : String(ev.seq);

        if (ev.type === "turn/started") {
          if (cursor.openTurnId) {
            // Missed completion — close the previous interval conservatively.
            stmts.closeOpenTurnsForThread.run(ev.createdAt, threadId, ev.createdAt);
          }
          // Historical replays can't know which model was live then; only
          // attribute a model to turns that started while we are running.
          const live = ev.createdAt >= processStart - POLL_MS;
          const meta = live
            ? await snapshotThread(threadId)
            : { model: "unknown", providerId: "" };
          cursor.openTurnId = evTurnId;
          cursor.openTurnStartedAt = ev.createdAt;
          stmts.insertTurn.run(
            threadId,
            evTurnId,
            session?.id ?? null,
            meta.providerId || "",
            meta.model,
            ev.createdAt,
          );
        } else if (ev.type === "turn/completed") {
          if (!cursor.openTurnId) {
            // Crash mid-turn: recover the stored open interval.
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
          }
          if (cursor.openTurnId) {
            const end = Math.max(ev.createdAt, cursor.openTurnStartedAt);
            stmts.closeOpenTurnsForThread.run(end, threadId, end + 1);
            cursor.openTurnId = null;
            cursor.openTurnStartedAt = 0;
          }
        }
      }
      stmts.setCursor.run(threadId, cursor.lastSeq);
    } catch (err) {
      bb.log.warn(`poll error ${threadId}: ${String(err)}`);
    } finally {
      polling.delete(threadId);
    }
  }

  // ---- startup reconciliation -------------------------------------------
  async function reconcile() {
    // Adopt or close persisted open sessions based on live status.
    for (const row of stmts.listOpenSessions.all() as {
      id: number;
      thread_id: string;
      started_at: number;
    }[]) {
      if (openSessions.has(row.thread_id)) continue;
      try {
        const t = await bb.sdk.threads.get({ threadId: row.thread_id });
        if (t.status === "active") {
          openSessions.set(row.thread_id, {
            id: row.id,
            threadId: row.thread_id,
            startedAt: row.started_at,
          });
          startPolling(row.thread_id);
        } else {
          stmts.closeSessionById.run(Date.now(), row.id);
        }
      } catch {
        stmts.closeSessionById.run(Date.now(), row.id);
      }
    }
    // Discover running threads (including hidden/child).
    try {
      let offset = 0;
      for (;;) {
        const rows = await bb.sdk.threads.list({
          limit: 100,
          offset,
          includeHidden: true,
        });
        for (const t of rows) {
          if (t.status === "active") void markActive(t.id, Date.now());
        }
        offset += rows.length;
        if (rows.length < 100 || offset > 5000) break;
      }
    } catch (err) {
      bb.log.warn(`reconcile failed: ${String(err)}`);
    }
  }

  // ---- lifecycle events --------------------------------------------------
  bb.events.on("thread.active", ({ thread }) =>
    void markActive(thread.id, Date.now()),
  );
  bb.events.on("thread.idle", ({ thread }) => void markInactive(thread.id, Date.now()));
  bb.events.on("thread.failed", ({ thread }) => void markInactive(thread.id, Date.now()));
  bb.events.on("thread.archived", ({ thread }) => void forgetThread(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => void forgetThread(thread.id));

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

  /** Split [start,end) into per-local-calendar-day segments. */
  function splitByDay(
    start: number,
    end: number,
    into: Map<string, Interval[]>,
  ): void {
    let cur = start;
    while (cur < end) {
      const key = dayKey(cur);
      const d = new Date(cur);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const segEnd = Math.min(end, dayEnd);
      if (!into.has(key)) into.set(key, []);
      into.get(key)!.push({ start: cur, end: segEnd });
      cur = segEnd;
    }
  }

  function dayKey(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function computeSummary(range: string) {
    const to = Date.now();
    const from = rangeStart(range);
    const activeEnd = `(COALESCE(ended_at, ${to}))`;

    const sessions = db
      .prepare(
        `SELECT id, project_name, machine_name, started_at,
                ${activeEnd} AS ended
           FROM sessions WHERE started_at < ? AND ${activeEnd} > ?`,
      )
      .all(to, from) as {
      id: number;
      project_name: string | null;
      machine_name: string | null;
      started_at: number;
      ended: number;
    }[];

    const allIntervals: Interval[] = sessions.map((s) => ({
      start: s.started_at,
      end: s.ended,
    }));
    const totalActiveMs = unionMs(allIntervals, from, to);

    const dayMap = new Map<string, Interval[]>();
    const computeDayMap = new Map<string, Interval[]>();
    for (const s of sessions) {
      splitByDay(Math.max(s.started_at, from), Math.min(s.ended, to), dayMap);
    }

    const turns = db
      .prepare(
        `SELECT provider_id, model, started_at, ${activeEnd} AS ended
           FROM turns WHERE started_at < ? AND ${activeEnd} > ?`,
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
    for (const t of turns) {
      const iv = { start: t.started_at, end: t.ended };
      splitByDay(iv.start, iv.end, computeDayMap);
      const key = `${t.provider_id}/${t.model}`;
      const m = modelMap.get(key) ?? {
        model: t.model || "unknown",
        providerId: t.provider_id || "unknown",
        computeMs: 0,
        turnCount: 0,
      };
      m.computeMs += Math.max(0, Math.min(t.ended, to) - Math.max(t.started_at, from));
      m.turnCount += 1;
      modelMap.set(key, m);
    }
    const totalComputeMs = [...computeDayMap.values()].flat().reduce(
      (acc, iv) => acc + (iv.end - iv.start),
      0,
    );

    const days = [...new Set([...dayMap.keys(), ...computeDayMap.keys()])]
      .sort()
      .map((date) => ({
        date,
        activeMs: unionMs(dayMap.get(date) ?? [], from, to),
        computeMs: unionMs(computeDayMap.get(date) ?? [], from, to),
      }));

    function dimUnion(get: (s: (typeof sessions)[number]) => string | null) {
      const map = new Map<string, Interval[]>();
      for (const s of sessions) {
        const name = get(s) || "unknown";
        if (!map.has(name)) map.set(name, []);
        map.get(name)!.push({ start: s.started_at, end: s.ended });
      }
      return [...map.entries()]
        .map(([name, ivs]) => ({ name, activeMs: unionMs(ivs, from, to) }))
        .sort((a, b) => b.activeMs - a.activeMs);
    }

    const cap = (ms: number) => Math.min(ms, Math.max(0, to - from));

    return {
      totalActiveMs: cap(totalActiveMs),
      totalComputeMs,
      turnCount: turns.length,
      days,
      projects: dimUnion((s) => s.project_name),
      machines: dimUnion((s) => s.machine_name),
      models: [...modelMap.values()].sort((a, b) => b.computeMs - a.computeMs),
    };
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
        ...s.projects.slice(0, 5).map((p) => `  ${p.name}: ${fmt(p.activeMs)}`),
        "Top machines:",
        ...s.machines.slice(0, 5).map((m) => `  ${m.name}: ${fmt(m.activeMs)}`),
        "Models:",
        ...s.models
          .slice(0, 5)
          .map((m) => `  ${m.providerId}/${m.model}: ${fmt(m.computeMs)} (${m.turnCount} turns)`),
      ];
      return { exitCode: 0, stdout: lines.join("\n") + "\n" };
    },
  });

  // ---- startup / shutdown -------------------------------------------------
  await reconcile();

  bb.background.service("reconciler", {
    async start(signal) {
      while (!signal.aborted) {
        await sleep(60_000, signal);
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
    const now = Date.now();
    for (const t of pollers.values()) clearInterval(t);
    pollers.clear();
    // Close everything at dispose time; reconciliation re-adopts on load.
    stmts.closeAllOpenSessions.run(now);
    stmts.closeAllOpenTurns.run(now, now);
  });

  bb.log.info("wakatime plugin loaded");
}
