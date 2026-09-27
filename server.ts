import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  aggregateAnalytics,
  isValidTimeZone,
  normalizeTimeZone,
  rangeStart,
  type RangeKey,
  type SessionInterval,
  type TurnInterval,
} from "./analytics.js";
import {
  planTurnEventBatch,
  historicalTurnEvidence,
  persistPlannedBatch,
  type CollectorCursor,
  type TurnLifecycleEvent,
} from "./collector.js";

const POLL_MS = 10_000;
const OBSERVATION_GAP_MS = 3 * POLL_MS;

const breakdownSchema = z
  .object({ name: z.string(), workingMs: z.number(), activeMs: z.number() })
  .strict();
// Deliberately not validated as an IANA zone here: a viewer whose browser
// reports a zone this server's ICU does not know would fail the whole request
// and blank the dashboard. `computeSummary` falls back instead, and the
// response echoes the zone actually used so the UI can label itself honestly.
const timeZoneSchema = z.string().max(100).optional();
const summaryOutputSchema = z
  .object({
    range: z
      .object({ key: z.enum(["today", "7d", "30d", "all"]), from: z.number(), to: z.number(), timezone: z.string() })
      .strict(),
    generatedAt: z.number(),
    workingMs: z.number(), agentRuntimeMs: z.number(), agentCoverageMs: z.number(),
    totalActiveMs: z.number(), totalComputeMs: z.number(), turnCount: z.number(),
    days: z.array(z.object({
      date: z.string(), workingMs: z.number(), agentRuntimeMs: z.number(),
      agentCoverageMs: z.number(), activeMs: z.number(), computeMs: z.number(),
      coverageMs: z.number(), turnCount: z.number(), peakConcurrentTurns: z.number(),
    }).strict()),
    profile: z.object({ hours: z.array(z.number()), weekdays: z.array(z.number()) }).strict(),
    previous: z
      .object({ workingMs: z.number(), agentRuntimeMs: z.number(), turnCount: z.number() })
      .strict()
      .nullable(),
    projects: z.array(breakdownSchema), machines: z.array(breakdownSchema),
    models: z.array(z.object({
      providerId: z.string(), model: z.string(), agentRuntimeMs: z.number(),
      computeMs: z.number(), turnCount: z.number(), sampledTurnCount: z.number(),
    }).strict()),
    projectModels: z.array(z.object({
      projectName: z.string(), providerId: z.string(), model: z.string(),
      agentRuntimeMs: z.number(), turnCount: z.number(),
    }).strict()),
    concurrency: z.object({
      averageConcurrentTurns: z.number(), peakConcurrentTurns: z.number(),
      swarmTimeMs: z.number(),
      distribution: z.array(z.object({ concurrentTurns: z.number(), durationMs: z.number() }).strict()),
    }).strict(),
    pace: z.object({
      coveredWorkingMs: z.number(), coveragePercent: z.number(), idleRunwayMs: z.number(),
      longestIdleRunwayMs: z.number(), medianTurnMs: z.number(), p90TurnMs: z.number(),
      turnsPerActiveHour: z.number(),
    }).strict(),
    streak: z.object({
      currentDays: z.number(), longestDays: z.number(),
      busiestDay: z.object({ date: z.string(), workingMs: z.number() }).strict().nullable(),
    }).strict(),
    quality: z.object({
      sessionCount: z.number(), openSessionCount: z.number(), recoveredSessionCount: z.number(),
      sampledTurnCount: z.number(), recoveredTurnCount: z.number(), unknownModelTurnCount: z.number(),
      linkedProjectModelTurnCount: z.number(),
    }).strict(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getActivityStatus: {
    input: z.null(),
    output: z.object({ active: z.boolean() }).strict(),
  },
  getSummary: {
    input: z.object({
      range: z.enum(["today", "7d", "30d", "all"]),
      timezone: timeZoneSchema,
    }).strict(),
    output: summaryOutputSchema,
  },
});

interface ThreadSnapshot {
  projectId: string | null; projectName: string | null;
  hostId: string | null; machineName: string | null;
  providerId: string; model: string;
}
interface CursorRow {
  last_seq: number;
  active_turn_id: string | null;
  pending_interaction_ids: string;
}

function parsePendingInteractionIds(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return [] }
}

function parseInteraction(data: unknown): TurnLifecycleEvent["interaction"] {
  if (!data || typeof data !== "object") return undefined;
  const interaction = (data as Record<string, unknown>).interaction;
  if (!interaction || typeof interaction !== "object") return undefined;
  const { id, status } = interaction as Record<string, unknown>;
  return typeof id === "string" && typeof status === "string" ? { id, status } : undefined;
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
      last_seq INTEGER NOT NULL,
      active_turn_id TEXT,
      pending_interaction_ids TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS session_metadata (
      session_id INTEGER PRIMARY KEY,
      project_id TEXT,
      host_id TEXT,
      quality TEXT NOT NULL DEFAULT 'legacy-unknown',
      closure_reason TEXT NOT NULL DEFAULT 'legacy-unknown'
    )`,
    `CREATE TABLE IF NOT EXISTS turn_metadata (
      turn_row_id INTEGER PRIMARY KEY,
      attribution_quality TEXT NOT NULL DEFAULT 'legacy-unknown',
      closure_reason TEXT NOT NULL DEFAULT 'legacy-unknown'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_metadata_project ON session_metadata(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_turn_metadata_quality ON turn_metadata(attribution_quality)`,
    // Per-turn evidence, never the plugin process's heartbeat.
    `CREATE TABLE IF NOT EXISTS turn_observations (
      turn_row_id INTEGER PRIMARY KEY,
      confirmed_at INTEGER NOT NULL
    )`,
    `ALTER TABLE turn_metadata ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS turn_history_segments (
      turn_row_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      PRIMARY KEY (turn_row_id, ordinal)
    )`,
  ]);

  // v0.1 used project_id/machine_id columns. Keep its table and every row;
  // nullable display columns are a safe additive compatibility migration.
  const sessionColumns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!sessionColumns.some((column) => column.name === "project_name")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN project_name TEXT`);
  }
  if (!sessionColumns.some((column) => column.name === "machine_name")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN machine_name TEXT`);
  }

  const cursorColumns = db.prepare(`PRAGMA table_info(poll_cursors)`).all() as { name: string }[];
  if (!cursorColumns.some((column) => column.name === "active_turn_id")) {
    db.exec(`ALTER TABLE poll_cursors ADD COLUMN active_turn_id TEXT`);
  }
  if (!cursorColumns.some((column) => column.name === "pending_interaction_ids")) {
    db.exec(`ALTER TABLE poll_cursors ADD COLUMN pending_interaction_ids TEXT NOT NULL DEFAULT '[]'`);
  }

  let disposed = false;
  const abort = new AbortController();
  const locks = new Map<string, Promise<void>>();
  const watched = new Set<string>();
  const openTurn = db.prepare(`SELECT t.id, t.turn_id, t.session_id, t.started_at,
    o.confirmed_at FROM turns t LEFT JOIN turn_observations o ON o.turn_row_id = t.id
    WHERE t.thread_id = ? AND t.ended_at IS NULL ORDER BY t.id DESC LIMIT 1`);
  const cursorQuery = db.prepare(`SELECT last_seq, active_turn_id, pending_interaction_ids
    FROM poll_cursors WHERE thread_id = ?`);
  const saveCursor = db.prepare(`INSERT INTO poll_cursors
    (thread_id, last_seq, active_turn_id, pending_interaction_ids) VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq,
    active_turn_id = excluded.active_turn_id, pending_interaction_ids = excluded.pending_interaction_ids`);
  type OpenTurn = { id: number; turn_id: string; session_id: number | null;
    started_at: number; confirmed_at: number | null };

  // No caches are changed inside a database transaction. A failed page can be
  // replayed without leaving an in-memory session that was rolled back.
  function closeIntervals(threadId: string, at: number | null, reason: string) {
    const rows = db.prepare(`SELECT t.id, t.started_at, o.confirmed_at FROM turns t
      LEFT JOIN turn_observations o ON o.turn_row_id = t.id
      WHERE t.thread_id = ? AND t.ended_at IS NULL`).all(threadId) as
      { id: number; started_at: number; confirmed_at: number | null }[];
    for (const row of rows) {
      const end = Math.max(row.started_at, at ?? row.confirmed_at ?? row.started_at);
      db.prepare(`UPDATE turns SET ended_at = ? WHERE id = ?`).run(end, row.id);
      db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason)
        VALUES (?, 'historical-unknown', ?) ON CONFLICT(turn_row_id)
        DO UPDATE SET closure_reason = excluded.closure_reason`).run(row.id, reason);
    }
    // Sessions carry attribution only. They are never independently counted.
    db.prepare(`UPDATE sessions SET ended_at = MAX(started_at, COALESCE(?, started_at))
      WHERE thread_id = ? AND ended_at IS NULL`).run(at, threadId);
    db.prepare(`UPDATE session_metadata SET closure_reason = ? WHERE session_id IN
      (SELECT id FROM sessions WHERE thread_id = ? AND ended_at IS NOT NULL)
      AND closure_reason = 'open'`).run(reason, threadId);
  }

  function startInterval(threadId: string, turnId: string, at: number, snapshot?: ThreadSnapshot) {
    if (db.prepare(`SELECT id FROM turns WHERE thread_id = ? AND turn_id = ?`).get(threadId, turnId)) return;
    closeIntervals(threadId, null, 'superseded');
    const session = db.prepare(`INSERT INTO sessions
      (thread_id, project_name, machine_name, started_at) VALUES (?, ?, ?, ?)`)
      .run(threadId, snapshot?.projectName ?? null, snapshot?.machineName ?? null, at);
    const sessionId = Number(session.lastInsertRowid);
    db.prepare(`INSERT INTO session_metadata
      (session_id, project_id, host_id, quality, closure_reason) VALUES (?, ?, ?, ?, 'open')`)
      .run(sessionId, snapshot?.projectId ?? null, snapshot?.hostId ?? null,
        snapshot ? 'observed' : 'historical');
    const turn = db.prepare(`INSERT INTO turns
      (thread_id, turn_id, session_id, provider_id, model, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(threadId, turnId, sessionId, snapshot?.providerId ?? '', snapshot?.model ?? 'unknown', at);
    db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason, accounting_version)
      VALUES (?, ?, 'open', 3)`).run(Number(turn.lastInsertRowid), snapshot ? 'sampled-live' : 'historical-unknown');
  }

  function isActive() {
    const row = db.prepare(`SELECT 1 FROM turns t JOIN turn_observations o ON o.turn_row_id = t.id
      WHERE t.ended_at IS NULL AND o.confirmed_at >= ? LIMIT 1`).get(Date.now() - OBSERVATION_GAP_MS);
    return Boolean(row);
  }
  function publishActivityStatus() {
    if (!disposed) bb.realtime.publish('activity-status', { active: isActive() });
  }
  function withLock(threadId: string, work: () => Promise<void>): Promise<void> {
    const previous = locks.get(threadId) ?? Promise.resolve();
    const next = previous.then(async () => { if (!disposed) await work(); }).catch((error) => {
      if (!disposed) {
        db.transaction(() => closeIntervals(threadId, null, 'observation-failed'))();
        publishActivityStatus();
        bb.log.warn(`activity verification failed for ${threadId}: ${String(error)}`);
      }
    }).finally(() => { if (locks.get(threadId) === next) locks.delete(threadId); });
    locks.set(threadId, next);
    return next;
  }

  async function snapshotThread(threadId: string): Promise<ThreadSnapshot> {
    let projectId: string | null = null;
    let hostId: string | null = null;
    let providerId = "Unknown";
    let model = "unknown";
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      projectId = thread.projectId ?? null;
      providerId = thread.providerId || "Unknown";
      if (thread.environmentId) {
        try {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          hostId = environment.hostId ?? null;
        } catch { /* attribution remains unknown rather than guessed */ }
      }
    } catch { /* the interval remains measurable without dimensions */ }
    try {
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (options?.model) model = options.model;
    } catch { /* keep the explicit unknown bucket */ }

    let projectName: string | null = null;
    if (projectId) {
      try { projectName = (await bb.sdk.projects.get({ projectId })).name ?? projectId }
      catch { projectName = projectId }
    }
    let machineName: string | null = null;
    if (hostId) {
      try { machineName = (await bb.sdk.hosts.get({ hostId })).name ?? hostId }
      catch { machineName = hostId }
    }

    return { projectId, projectName, hostId, machineName, providerId, model };
  }

  async function drainEvents(threadId: string) {
    // Finish every page before any open turn is considered live. A page ending
    // at a historical start is not evidence that the turn is still running.
    for (let page = 0; page < 100; page += 1) {
      const durable = cursorQuery.get(threadId) as CursorRow | undefined;
      const open = openTurn.get(threadId) as OpenTurn | undefined;
      const pending = parsePendingInteractionIds(durable?.pending_interaction_ids);
      const initial: CollectorCursor = {
        lastSeq: durable?.last_seq ?? 0,
        activeTurnId: durable?.active_turn_id ?? null,
        openTurnId: pending.length ? null : (open?.turn_id ?? durable?.active_turn_id ?? null),
        openTurnStartedAt: open?.started_at ?? 0,
        pendingInteractionIds: pending,
      };
      const events = await bb.sdk.threads.events.list({ threadId,
        types: ['turn/started', 'turn/completed', 'system/interaction/lifecycle'],
        order: 'asc', limit: '1000', signal: abort.signal,
        ...(initial.lastSeq > 0 ? { afterSeq: String(initial.lastSeq) } : {}),
      });
      if (disposed) return;
      if (events.some((event) => !Number.isFinite(event.createdAt) || event.createdAt < 0
        || event.createdAt > Date.now() || !Number.isSafeInteger(event.seq) || event.seq < 0)) {
        throw new Error('invalid lifecycle event timestamp or sequence');
      }
      const lifecycle = events.map((event): TurnLifecycleEvent => ({ seq: event.seq,
        type: event.type as TurnLifecycleEvent['type'], createdAt: event.createdAt,
        interaction: event.type === 'system/interaction/lifecycle' ? parseInteraction(event.data) : undefined,
      }));
      const planned = planTurnEventBatch(initial, lifecycle);
      const snapshots = new Map<string, ThreadSnapshot>();
      for (const op of planned.operations) {
        if (op.kind === 'start' && op.startedAt >= processStart) {
          snapshots.set(op.turnId, await snapshotThread(threadId));
        }
      }
      if (disposed) return;
      persistPlannedBatch(planned, {
        transaction: (work) => db.transaction(work)(),
        apply(op) {
          if (op.kind === 'start') startInterval(threadId, op.turnId, op.startedAt, snapshots.get(op.turnId));
          else if (op.kind === 'pause') closeIntervals(threadId, op.endedAt, 'interaction-pending');
          else closeIntervals(threadId, op.reason === 'superseded' ? null : op.endedAt, op.reason);
        },
        persistCursor(next) {
          saveCursor.run(threadId, next.lastSeq, next.activeTurnId, JSON.stringify(next.pendingInteractionIds));
        },
      });
      if (events.length < 1000) return;
      if (planned.next.lastSeq <= initial.lastSeq) throw new Error('event pagination made no progress');
    }
    throw new Error('event backlog not yet drained');
  }

  async function syncThread(threadId: string, terminal = false) {
    watched.add(threadId);
    await withLock(threadId, async () => {
      try {
        // Expire evidence before doing network work. Slow or failing SDK calls
        // cannot bridge an unobserved gap or keep a clock running indefinitely.
        const prior = openTurn.get(threadId) as OpenTurn | undefined;
        if (prior?.confirmed_at != null && Date.now() - prior.confirmed_at > OBSERVATION_GAP_MS) {
          db.transaction(() => closeIntervals(threadId, null, 'observation-gap'))();
        }
        await drainEvents(threadId);
        if (disposed) return;
        if (terminal) {
          db.transaction(() => {
            closeIntervals(threadId, null, 'inactive');
            db.prepare(`UPDATE poll_cursors SET active_turn_id = NULL, pending_interaction_ids = '[]'
              WHERE thread_id = ?`).run(threadId);
          })();
          watched.delete(threadId);
          publishActivityStatus();
          return;
        }
        const thread = await bb.sdk.threads.get({ threadId, signal: abort.signal });
        if (disposed) return;
        const running = thread.status === 'active' && thread.runtime.displayStatus === 'active'
          && thread.archivedAt === null && thread.deletedAt === null;
        const pending = running ? await bb.sdk.threads.interactions.list({ threadId, signal: abort.signal }) : [];
        if (disposed) return;
        const cursor = cursorQuery.get(threadId) as CursorRow | undefined;
        if (!running || pending.length || !cursor?.active_turn_id
          || parsePendingInteractionIds(cursor.pending_interaction_ids).length) {
          db.transaction(() => closeIntervals(threadId, null, 'not-running'))();
          if (!running && thread.status !== 'active') {
            db.prepare(`UPDATE poll_cursors SET active_turn_id = NULL WHERE thread_id = ?`).run(threadId);
            watched.delete(threadId);
          }
          publishActivityStatus();
          return;
        }
        const now = Date.now();
        const existing = openTurn.get(threadId) as OpenTurn | undefined;
        const needsSegment = !existing || (existing.confirmed_at === null && existing.started_at < processStart)
          || (existing.confirmed_at !== null && now - existing.confirmed_at > OBSERVATION_GAP_MS);
        const snapshot = needsSegment ? await snapshotThread(threadId) : undefined;
        if (disposed) return;
        db.transaction(() => {
          if (needsSegment) {
            closeIntervals(threadId, null, 'unobserved');
            startInterval(threadId, `${cursor.active_turn_id}:observed:${now}`, now, snapshot);
          }
          const row = openTurn.get(threadId) as OpenTurn;
          db.prepare(`INSERT INTO turn_observations (turn_row_id, confirmed_at) VALUES (?, ?)
            ON CONFLICT(turn_row_id) DO UPDATE SET confirmed_at = MAX(confirmed_at, excluded.confirmed_at)`)
            .run(row.id, Math.max(row.started_at, now));
        })();
        publishActivityStatus();
      } finally {
        if (terminal && !disposed) {
          watched.delete(threadId);
          db.prepare(`UPDATE poll_cursors SET active_turn_id = NULL, pending_interaction_ids = '[]'
            WHERE thread_id = ?`).run(threadId);
        }
      }
    });
  }

  async function recheckHistory(threadId: string) {
    const events: TurnLifecycleEvent[] = [];
    let afterSeq = 0;
    for (let page = 0; page < 100; page += 1) {
      const rows = await bb.sdk.threads.events.list({ threadId,
        types: ['turn/started', 'turn/completed', 'system/interaction/lifecycle'],
        order: 'asc', limit: '1000', signal: abort.signal,
        ...(afterSeq ? { afterSeq: String(afterSeq) } : {}),
      });
      if (disposed) return;
      for (const row of rows) {
        if (!Number.isFinite(row.createdAt) || row.createdAt < 0 || row.createdAt > Date.now()
          || !Number.isSafeInteger(row.seq) || row.seq <= afterSeq) throw new Error('invalid historical event page');
        events.push({ seq: row.seq, type: row.type as TurnLifecycleEvent['type'], createdAt: row.createdAt,
          interaction: row.type === 'system/interaction/lifecycle' ? parseInteraction(row.data) : undefined });
      }
      if (rows.length < 1000) {
        const evidence = historicalTurnEvidence(events);
        db.transaction(() => {
          const legacy = db.prepare(`SELECT t.id, t.turn_id, t.started_at, t.ended_at
            FROM turns t LEFT JOIN turn_metadata m ON m.turn_row_id = t.id
            WHERE t.thread_id = ? AND COALESCE(m.accounting_version, 0) = 0 AND t.ended_at IS NOT NULL`)
            .all(threadId) as { id: number; turn_id: string; started_at: number; ended_at: number }[];
          for (const turn of legacy) {
            let ordinal = 0;
            for (const interval of evidence) {
              if (interval.turnId !== turn.turn_id.split(':')[0]) continue;
              const start = Math.max(turn.started_at, interval.start);
              const end = Math.min(turn.ended_at, interval.end);
              if (end <= start) continue;
              db.prepare(`INSERT INTO turn_history_segments (turn_row_id, ordinal, started_at, ended_at)
                VALUES (?, ?, ?, ?)`).run(turn.id, ordinal++, start, end);
            }
            db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason, accounting_version)
              VALUES (?, 'legacy-unknown', 'legacy-unknown', 2) ON CONFLICT(turn_row_id)
              DO UPDATE SET accounting_version = 2`).run(turn.id);
          }
        })();
        return;
      }
      const next = Math.max(...rows.map((row) => row.seq));
      if (next <= afterSeq) throw new Error('historical pagination made no progress');
      afterSeq = next;
    }
    throw new Error('historical event backlog too large');
  }

  let historyAfter: string | null = null;
  async function recheckPendingHistory(limit: number) {
    const after = limit === 10 ? historyAfter : null;
    const rows = db.prepare(`SELECT DISTINCT t.thread_id FROM turns t
      LEFT JOIN turn_metadata m ON m.turn_row_id = t.id
      WHERE COALESCE(m.accounting_version, 0) = 0 AND t.ended_at IS NOT NULL
      AND (? IS NULL OR t.thread_id > ?) ORDER BY t.thread_id LIMIT ?`)
      .all(after, after, limit) as { thread_id: string }[];
    for (const row of rows) await withLock(row.thread_id, () => recheckHistory(row.thread_id));
    if (limit === 10) historyAfter = rows.at(-1)?.thread_id ?? null;
    return rows.length;
  }

  async function reconcile() {
    const candidates = new Set(watched);
    for (let offset = 0; ; offset += 100) {
      const rows = await bb.sdk.threads.list({ limit: 100, offset, includeHidden: true, signal: abort.signal });
      if (disposed) return;
      for (const row of rows) if (row.status === 'active' && !row.archivedAt && !row.deletedAt) candidates.add(row.id);
      if (rows.length < 100) break;
    }
    // Include previously tracked threads even if idle/archived/absent from list.
    for (const id of candidates) await syncThread(id);
    // Bound upgrade work per sweep; an explicit CLI command can finish it now.
    await recheckPendingHistory(10);
  }

  // Close orphan turns too, including those with no session. A global process
  // heartbeat says nothing about whether a particular agent was active.
  db.transaction(() => {
    const rows = db.prepare(`SELECT thread_id FROM turns WHERE ended_at IS NULL
      UNION SELECT thread_id FROM sessions WHERE ended_at IS NULL`).all() as { thread_id: string }[];
    for (const row of rows) closeIntervals(row.thread_id, null, 'crash-recovery');
  })();

  bb.events.on('thread.active', ({ thread }) => syncThread(thread.id));
  bb.events.on('thread.idle', ({ thread }) => syncThread(thread.id, true));
  bb.events.on('thread.failed', ({ thread }) => syncThread(thread.id, true));
  bb.events.on('thread.archived', ({ thread }) => syncThread(thread.id, true));
  bb.events.on('thread.deleted', ({ thread }) => syncThread(thread.id, true));

  /** Sessions provide dimensions; only bounded turn evidence contributes time.
   * Legacy inflated session rows remain intact for audit/rollback, but cannot
   * affect totals, daily bars, profiles, or project/machine breakdowns. */
  function analyzeWindow(from: number, to: number, timeZone: string) {
    const rows = db.prepare(`SELECT t.id, t.provider_id, t.model,
      CASE WHEN tm.accounting_version = 2 THEN h.started_at ELSE t.started_at END AS started_at,
      CASE
        WHEN tm.accounting_version = 2 THEN h.ended_at
        WHEN t.ended_at IS NULL THEN COALESCE(o.confirmed_at, t.started_at)
        WHEN tm.closure_reason IN ('completed', 'interaction-pending') THEN t.ended_at
        ELSE MIN(t.ended_at, COALESCE(o.confirmed_at, t.started_at))
      END AS ended_at, s.project_name, s.machine_name,
      COALESCE(tm.attribution_quality, 'legacy-unknown') AS attribution_quality,
      COALESCE(tm.closure_reason, 'legacy-unknown') AS closure_reason
      FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
      LEFT JOIN turn_metadata tm ON tm.turn_row_id = t.id
      LEFT JOIN turn_observations o ON o.turn_row_id = t.id
      LEFT JOIN turn_history_segments h ON h.turn_row_id = t.id AND tm.accounting_version = 2
      WHERE t.started_at < ? AND tm.accounting_version IN (2, 3)`).all(to) as {
        id: number; provider_id: string; model: string; started_at: number; ended_at: number;
        project_name: string | null; machine_name: string | null;
        attribution_quality: string; closure_reason: string;
      }[];
    const turns = rows.filter((row) => row.ended_at > from && row.ended_at > row.started_at);
    return aggregateAnalytics(
      turns.map((row): SessionInterval => ({ id: row.id,
        projectName: row.project_name, machineName: row.machine_name,
        start: row.started_at, end: row.ended_at, closureReason: row.closure_reason,
      })),
      turns.map((row): TurnInterval => ({ providerId: row.provider_id, model: row.model,
        projectName: row.project_name, start: row.started_at, end: row.ended_at,
        attributionQuality: row.attribution_quality, closureReason: row.closure_reason,
      })), from, to, timeZone,
    );
  }

  function computeSummary(range: RangeKey, requestedTimeZone?: string) {
    const to = Date.now();
    if (requestedTimeZone !== undefined && !isValidTimeZone(requestedTimeZone)) {
      bb.log.warn(`ignoring unrecognized timezone ${JSON.stringify(requestedTimeZone)}`);
    }
    const timeZone = normalizeTimeZone(requestedTimeZone);
    const earliest = db.prepare(`SELECT MIN(at) AS earliest FROM (
      SELECT MIN(started_at) AS at FROM sessions UNION ALL SELECT MIN(started_at) AS at FROM turns
    )`).get() as { earliest: number | null };
    const from = rangeStart(range, to, earliest.earliest ?? undefined, timeZone);
    const analytics = analyzeWindow(from, to, timeZone);
    // The comparison window is the same length immediately before this one.
    // "All time" starts at the first row, so nothing precedes it to compare.
    const before = range === "all" ? null : analyzeWindow(from - (to - from), from, timeZone);
    return {
      range: { key: range, from, to, timezone: timeZone },
      generatedAt: to,
      workingMs: analytics.workingMs, agentRuntimeMs: analytics.agentRuntimeMs,
      agentCoverageMs: analytics.agentCoverageMs, totalActiveMs: analytics.workingMs,
      totalComputeMs: analytics.agentRuntimeMs, turnCount: analytics.turnCount,
      days: analytics.days.map((day) => ({
        ...day, activeMs: day.workingMs, computeMs: day.agentRuntimeMs, coverageMs: day.agentCoverageMs,
      })),
      profile: analytics.profile,
      previous: before && {
        workingMs: before.workingMs,
        agentRuntimeMs: before.agentRuntimeMs,
        turnCount: before.turnCount,
      },
      projects: analytics.projects.map((row) => ({ ...row, activeMs: row.workingMs })),
      machines: analytics.machines.map((row) => ({ ...row, activeMs: row.workingMs })),
      models: analytics.models.map((row) => ({
        providerId: row.providerId,
        model: row.model,
        agentRuntimeMs: row.agentRuntimeMs,
        computeMs: row.agentRuntimeMs,
        turnCount: row.turnCount,
        sampledTurnCount: row.observedTurnCount,
      })),
      projectModels: analytics.projectModels,
      concurrency: {
        averageConcurrentTurns: analytics.averageConcurrentTurns,
        peakConcurrentTurns: analytics.peakConcurrentTurns,
        swarmTimeMs: analytics.swarmTimeMs, distribution: analytics.distribution,
      },
      pace: {
        coveredWorkingMs: analytics.coveredWorkingMs, coveragePercent: analytics.coveragePercent,
        idleRunwayMs: analytics.idleRunwayMs, longestIdleRunwayMs: analytics.longestIdleRunwayMs,
        medianTurnMs: analytics.medianTurnMs, p90TurnMs: analytics.p90TurnMs,
        turnsPerActiveHour: analytics.turnsPerActiveHour,
      },
      streak: {
        currentDays: analytics.currentStreakDays, longestDays: analytics.longestStreakDays,
        busiestDay: analytics.busiestDay,
      },
      quality: {
        sessionCount: analytics.quality.sessionCount, openSessionCount: analytics.quality.openSessionCount,
        recoveredSessionCount: analytics.quality.recoveredSessionCount,
        sampledTurnCount: analytics.quality.observedTurnCount,
        recoveredTurnCount: analytics.quality.recoveredTurnCount,
        unknownModelTurnCount: analytics.quality.unknownModelTurnCount,
        linkedProjectModelTurnCount: analytics.quality.reliableProjectModelTurnCount,
      },
    };
  }

  bb.rpc.register(rpcContract, {
    getActivityStatus() { return { active: isActive() } },
    getSummary({ range, timezone }) { return computeSummary(range, timezone) },
  });
  bb.cli.register({
    name: "wakatime", summary: "Show honest interval-derived bb agent activity",
    commands: [
      { name: "today", summary: "Today's agent activity", usage: "bb wakatime today" },
      { name: "week", summary: "The last 7 calendar days", usage: "bb wakatime week" },
      { name: "recheck-history", summary: "Verify legacy turn intervals against retained lifecycle events", usage: "bb wakatime recheck-history" },
    ],
    async run(argv) {
      if (argv[0] === 'recheck-history') {
        const checked = await recheckPendingHistory(10_000);
        const remaining = db.prepare(`SELECT COUNT(DISTINCT t.thread_id) AS count FROM turns t
          LEFT JOIN turn_metadata m ON m.turn_row_id = t.id
          WHERE COALESCE(m.accounting_version, 0) = 0 AND t.ended_at IS NOT NULL`).get() as { count: number };
        return { exitCode: remaining.count ? 1 : 0,
          stdout: `Historical threads checked: ${checked}; awaiting evidence: ${remaining.count}\n` };
      }
      const summary = computeSummary(argv[0] === "week" ? "7d" : "today");
      const format = (ms: number) => {
        const minutes = Math.round(ms / 60_000);
        return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
      };
      return { exitCode: 0, stdout: [
        `bb agent activity (${summary.range.key})`,
        `working time (union): ${format(summary.workingMs)}`,
        `agent runtime (sum): ${format(summary.agentRuntimeMs)}`,
        `agent coverage (union): ${format(summary.agentCoverageMs)}`,
        `turns: ${summary.turnCount}`,
        `concurrency: ${summary.concurrency.averageConcurrentTurns.toFixed(2)} avg, ${summary.concurrency.peakConcurrentTurns} peak`,
        `swarm time (2+ turns): ${format(summary.concurrency.swarmTimeMs)}`,
      ].join("\n") + "\n" };
    },
  });

  bb.onDispose(() => {
    disposed = true;
    abort.abort();
    db.transaction(() => {
      const rows = db.prepare(`SELECT DISTINCT thread_id FROM turns WHERE ended_at IS NULL`).all() as { thread_id: string }[];
      for (const row of rows) closeIntervals(row.thread_id, null, 'plugin-dispose');
    })();
    watched.clear();
  });
  try { await reconcile() }
  catch (error) { bb.log.warn(`startup reconciliation failed: ${String(error)}`) }
  bb.background.service('reconciler', {
    async start(signal) {
      while (!signal.aborted && !disposed) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, POLL_MS);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
        if (signal.aborted || disposed) break;
        try { await reconcile() }
        catch (error) { bb.log.warn(`periodic reconciliation failed: ${String(error)}`) }
      }
    },
  });
  bb.log.info('wakatime strict turn accounting loaded');
}
