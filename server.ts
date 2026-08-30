import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  aggregateAnalytics,
  crashRecoveryEnd,
  isValidTimeZone,
  normalizeTimeZone,
  rangeStart,
  type RangeKey,
  type SessionInterval,
  type TurnInterval,
} from "./analytics.js";
import {
  planTurnEventBatch,
  persistPlannedBatch,
  type CollectorCursor,
  type TurnLifecycleEvent,
} from "./collector.js";

const POLL_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_GRACE_MS = 90_000;

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

interface OpenSession { id: number; threadId: string; startedAt: number }
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

  const statements = {
    openSession: db.prepare(`INSERT INTO sessions
      (thread_id, project_name, machine_name, started_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) WHERE ended_at IS NULL DO NOTHING`),
    findOpenSession: db.prepare(`SELECT id, started_at FROM sessions
      WHERE thread_id = ? AND ended_at IS NULL`),
    sessionMetadata: db.prepare(`INSERT INTO session_metadata
      (session_id, project_id, host_id, quality, closure_reason)
      VALUES (?, ?, ?, 'observed', 'open') ON CONFLICT(session_id) DO UPDATE SET
      project_id = COALESCE(session_metadata.project_id, excluded.project_id),
      host_id = COALESCE(session_metadata.host_id, excluded.host_id)`),
    closeSession: db.prepare(`UPDATE sessions SET ended_at = MAX(started_at, ?)
      WHERE id = ? AND ended_at IS NULL`),
    closeSessionMetadata: db.prepare(`UPDATE session_metadata SET closure_reason = ?
      WHERE session_id = ?`),
    listOpenSessions: db.prepare(`SELECT id, thread_id, started_at FROM sessions
      WHERE ended_at IS NULL`),
    findSessionCovering: db.prepare(`SELECT id FROM sessions
      WHERE thread_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY started_at DESC LIMIT 1`),
    truncateSession: db.prepare(`UPDATE sessions SET ended_at = MAX(started_at, ?)
      WHERE id = ?`),
    insertTurn: db.prepare(`INSERT INTO turns
      (thread_id, turn_id, session_id, provider_id, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, turn_id) DO NOTHING`),
    findTurn: db.prepare(`SELECT id FROM turns WHERE thread_id = ? AND turn_id = ?`),
    turnMetadata: db.prepare(`INSERT INTO turn_metadata
      (turn_row_id, attribution_quality, closure_reason) VALUES (?, ?, 'open')
      ON CONFLICT(turn_row_id) DO NOTHING`),
    openTurnRows: db.prepare(`SELECT id FROM turns WHERE thread_id = ? AND ended_at IS NULL`),
    ensureTurnClosure: db.prepare(`INSERT INTO turn_metadata
      (turn_row_id, attribution_quality, closure_reason) VALUES (?, 'legacy-unknown', ?)
      ON CONFLICT(turn_row_id) DO UPDATE SET closure_reason = excluded.closure_reason`),
    ensureSessionClosure: db.prepare(`INSERT INTO session_metadata
      (session_id, quality, closure_reason) VALUES (?, 'legacy-unknown', ?)
      ON CONFLICT(session_id) DO UPDATE SET closure_reason = excluded.closure_reason`),
    closeOpenTurns: db.prepare(`UPDATE turns SET ended_at = MAX(started_at, ?)
      WHERE thread_id = ? AND ended_at IS NULL`),
    closeOpenTurnMetadata: db.prepare(`UPDATE turn_metadata SET closure_reason = ?
      WHERE turn_row_id IN (SELECT id FROM turns WHERE thread_id = ? AND ended_at IS NOT NULL)
        AND closure_reason = 'open'`),
    findOpenTurn: db.prepare(`SELECT turn_id, started_at FROM turns
      WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`),
    findTurnCovering: db.prepare(`SELECT id FROM turns
      WHERE thread_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY started_at DESC LIMIT 1`),
    truncateTurn: db.prepare(`UPDATE turns SET ended_at = MAX(started_at, ?)
      WHERE id = ?`),
    getCursor: db.prepare(`SELECT last_seq, active_turn_id, pending_interaction_ids
      FROM poll_cursors WHERE thread_id = ?`),
    setCursor: db.prepare(`INSERT INTO poll_cursors
      (thread_id, last_seq, active_turn_id, pending_interaction_ids) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
      last_seq = MAX(poll_cursors.last_seq, excluded.last_seq),
      active_turn_id = excluded.active_turn_id,
      pending_interaction_ids = excluded.pending_interaction_ids`),
    setHeartbeat: db.prepare(`INSERT INTO meta (key, value) VALUES ('last_alive', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    getHeartbeat: db.prepare(`SELECT value FROM meta WHERE key = 'last_alive'`),
  };

  const persistedHeartbeat = (() => {
    const row = statements.getHeartbeat.get() as { value: string } | undefined;
    if (!row) return null;
    const value = Number(row.value);
    return Number.isFinite(value) ? Math.min(value, processStart) : null;
  })();

  const openSessions = new Map<string, OpenSession>();
  const cursors = new Map<string, CollectorCursor>();
  const locks = new Map<string, Promise<void>>();
  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  function markOpenTurnClosures(threadId: string, reason: string) {
    for (const row of statements.openTurnRows.all(threadId) as { id: number }[]) {
      statements.ensureTurnClosure.run(row.id, reason);
    }
  }

  function withLock(threadId: string, work: () => Promise<unknown>): Promise<void> {
    const previous = locks.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work).then(() => undefined, () => undefined);
    locks.set(threadId, next);
    return next;
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
      signal.addEventListener("abort", done, { once: true });
    });
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

  function openSessionInterval(threadId: string, at: number, snapshot: ThreadSnapshot): OpenSession {
    const result = statements.openSession.run(
      threadId, snapshot.projectName, snapshot.machineName, at,
    );
    const row = result.changes > 0
      ? { id: Number(result.lastInsertRowid), started_at: at }
      : statements.findOpenSession.get(threadId) as { id: number; started_at: number };
    statements.sessionMetadata.run(row.id, snapshot.projectId, snapshot.hostId);
    const session = { id: row.id, threadId, startedAt: row.started_at };
    openSessions.set(threadId, session);
    return session;
  }

  function closeSessionInterval(threadId: string, at: number, reason: string) {
    const cached = openSessions.get(threadId);
    const stored = statements.findOpenSession.get(threadId) as
      | { id: number; started_at: number } | undefined;
    const session = cached
      ?? (stored ? { id: stored.id, threadId, startedAt: stored.started_at } : undefined);
    if (!session) return;
    statements.ensureSessionClosure.run(session.id, reason);
    statements.closeSession.run(at, session.id);
    statements.closeSessionMetadata.run(reason, session.id);
    openSessions.delete(threadId);
  }

  const closeThreadIntervals = db.transaction((threadId: string, at: number, reason: string) => {
    markOpenTurnClosures(threadId, reason);
    statements.closeOpenTurns.run(at, threadId);
    statements.closeOpenTurnMetadata.run(reason, threadId);
    closeSessionInterval(threadId, at, reason);
  });

  function pauseIntervals(threadId: string, at: number) {
    const turn = statements.findTurnCovering.get(threadId, at, at) as { id: number } | undefined;
    if (turn) {
      statements.ensureTurnClosure.run(turn.id, "interaction-pending");
      statements.truncateTurn.run(at, turn.id);
    }

    const session = statements.findSessionCovering.get(threadId, at, at) as
      | { id: number } | undefined;
    if (session) {
      statements.ensureSessionClosure.run(session.id, "interaction-pending");
      statements.truncateSession.run(at, session.id);
      statements.closeSessionMetadata.run("interaction-pending", session.id);
      if (openSessions.get(threadId)?.id === session.id) {
        openSessions.delete(threadId);
      }
    }
  }

  function publishActivityStatus() {
    bb.realtime.publish("activity-status", { active: openSessions.size > 0 });
  }

  async function markActive(threadId: string, at: number) {
    await withLock(threadId, async () => {
      if (openSessions.has(threadId)) return;
      startPolling(threadId);
      const durable = statements.getCursor.get(threadId) as CursorRow | undefined;
      if (parsePendingInteractionIds(durable?.pending_interaction_ids).length > 0) {
        await drainEvents(threadId);
        return;
      }
      const snapshot = await snapshotThread(threadId);
      const session = db.transaction(() => {
        return openSessionInterval(threadId, at, snapshot);
      })();
      openSessions.set(threadId, session);
      publishActivityStatus();
      await drainEvents(threadId);
    });
  }

  function stopPolling(threadId: string) {
    const poller = pollers.get(threadId);
    if (poller) clearInterval(poller);
    pollers.delete(threadId);
  }
  function startPolling(threadId: string) {
    if (pollers.has(threadId)) return;
    pollers.set(threadId, setInterval(
      () => void withLock(threadId, () => drainEvents(threadId)), POLL_MS,
    ));
  }

  async function drainEvents(threadId: string) {
    const durable = statements.getCursor.get(threadId) as CursorRow | undefined;
    const openTurn = statements.findOpenTurn.get(threadId) as
      | { turn_id: string; started_at: number } | undefined;
    const initial: CollectorCursor = {
      lastSeq: durable?.last_seq ?? 0,
      activeTurnId: durable?.active_turn_id ?? openTurn?.turn_id ?? null,
      openTurnId: openTurn?.turn_id ?? null,
      openTurnStartedAt: openTurn?.started_at ?? 0,
      pendingInteractionIds: parsePendingInteractionIds(durable?.pending_interaction_ids),
    };
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/started", "turn/completed", "system/interaction/lifecycle"],
      order: "asc",
      limit: "1000",
      ...(initial.lastSeq > 0 ? { afterSeq: String(initial.lastSeq) } : {}),
    });
    const lifecycleEvents: TurnLifecycleEvent[] = events
      .filter((event) => event.type === "turn/started"
        || event.type === "turn/completed"
        || event.type === "system/interaction/lifecycle")
      .map((event) => ({
        seq: event.seq,
        type: event.type as TurnLifecycleEvent["type"],
        createdAt: event.createdAt,
        interaction: event.type === "system/interaction/lifecycle"
          ? parseInteraction(event.data)
          : undefined,
      }));
    const planned = planTurnEventBatch(initial, lifecycleEvents);
    if (planned.next.lastSeq === initial.lastSeq) { cursors.set(threadId, initial); return }

    const startMetadata = new Map<string, ThreadSnapshot>();
    for (const operation of planned.operations) {
      if (operation.kind === "start" && (operation.startedAt >= processStart - POLL_MS || operation.turnId.includes(":resume:"))) {
        startMetadata.set(operation.turnId, await snapshotThread(threadId));
      }
    }

    let activityChanged = false;
    const committedCursor = persistPlannedBatch(planned, {
      transaction: (work) => db.transaction(work)(),
      apply: (operation) => {
        if (operation.kind === "pause") {
          pauseIntervals(threadId, operation.endedAt);
          activityChanged = true;
          return;
        }
        if (operation.kind === "close") {
          markOpenTurnClosures(threadId, operation.reason);
          statements.closeOpenTurns.run(operation.endedAt, threadId);
          statements.closeOpenTurnMetadata.run(operation.reason, threadId);
          return;
        }
        const snapshot = startMetadata.get(operation.turnId);
        let currentSession = openSessions.get(threadId);
        if (!currentSession) {
          currentSession = openSessionInterval(threadId, operation.startedAt, snapshot ?? {
            projectId: null, projectName: null, hostId: null, machineName: null,
            providerId: "Unknown", model: "unknown",
          });
          activityChanged = true;
        }
        const belongsToCurrentSession = operation.startedAt >= currentSession.startedAt;
        statements.insertTurn.run(
          threadId, operation.turnId, belongsToCurrentSession ? currentSession.id : null,
          snapshot?.providerId ?? "", snapshot?.model ?? "unknown", operation.startedAt,
        );
        const turn = statements.findTurn.get(threadId, operation.turnId) as { id: number };
        statements.turnMetadata.run(turn.id, snapshot ? "sampled-live" : "historical-unknown");
      },
      persistCursor: (next) => {
        statements.setCursor.run(
          threadId, next.lastSeq, next.activeTurnId, JSON.stringify(next.pendingInteractionIds),
        );
      },
    });
    cursors.set(threadId, committedCursor);
    if (activityChanged) publishActivityStatus();
  }

  function markInactive(threadId: string, at: number, reason: string) {
    return withLock(threadId, async () => {
      try { await drainEvents(threadId) }
      catch (error) { bb.log.warn(`final event drain failed for ${threadId}: ${String(error)}`) }
      closeThreadIntervals(threadId, at, reason);
      openSessions.delete(threadId);
      publishActivityStatus();
      stopPolling(threadId);
    });
  }

  let recoveryComplete = false;
  async function reconcile() {
    if (!recoveryComplete) {
      // Never bridge an unobserved restart gap, even for a still-active thread.
      for (const row of statements.listOpenSessions.all() as {
        id: number; thread_id: string; started_at: number;
      }[]) {
        const end = crashRecoveryEnd(row.started_at, persistedHeartbeat, processStart, HEARTBEAT_GRACE_MS);
        db.transaction(() => {
          markOpenTurnClosures(row.thread_id, "crash-recovery");
          statements.closeOpenTurns.run(end, row.thread_id);
          statements.closeOpenTurnMetadata.run("crash-recovery", row.thread_id);
          statements.ensureSessionClosure.run(row.id, "crash-recovery");
          statements.closeSession.run(end, row.id);
          statements.closeSessionMetadata.run("crash-recovery", row.id);
        })();
      }
      recoveryComplete = true;
    }
    let offset = 0;
    for (;;) {
      const rows = await bb.sdk.threads.list({ limit: 100, offset, includeHidden: true });
      for (const thread of rows) if (thread.status === "active") void markActive(thread.id, Date.now());
      offset += rows.length;
      if (rows.length < 100 || offset >= 5000) break;
    }
  }

  bb.events.on("thread.active", ({ thread }) => void markActive(thread.id, Date.now()));
  bb.events.on("thread.idle", ({ thread }) => void markInactive(thread.id, Date.now(), "idle"));
  bb.events.on("thread.failed", ({ thread }) => void markInactive(thread.id, Date.now(), "failed"));
  bb.events.on("thread.archived", ({ thread }) => void markInactive(thread.id, Date.now(), "archived"));
  bb.events.on("thread.deleted", ({ thread }) => void markInactive(thread.id, Date.now(), "deleted"));

  /** Every interval overlapping a window, aggregated. `to` also closes open rows. */
  function analyzeWindow(from: number, to: number, openAt: number, timeZone: string) {
    const sessions = db.prepare(`SELECT s.id, s.project_name, s.machine_name, s.started_at,
      COALESCE(s.ended_at, ?) AS ended_at,
      COALESCE(sm.closure_reason, CASE WHEN s.ended_at IS NULL THEN 'open' ELSE 'legacy-unknown' END) AS closure_reason
      FROM sessions s LEFT JOIN session_metadata sm ON sm.session_id = s.id
      WHERE s.started_at < ? AND COALESCE(s.ended_at, ?) > ?`
    ).all(openAt, to, openAt, from) as {
      id: number; project_name: string | null; machine_name: string | null;
      started_at: number; ended_at: number; closure_reason: string;
    }[];
    const turns = db.prepare(`SELECT t.provider_id, t.model, t.started_at,
      COALESCE(t.ended_at, ?) AS ended_at, s.project_name,
      COALESCE(tm.attribution_quality, 'legacy-unknown') AS attribution_quality,
      COALESCE(tm.closure_reason, CASE WHEN t.ended_at IS NULL THEN 'open' ELSE 'legacy-unknown' END) AS closure_reason
      FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
      LEFT JOIN turn_metadata tm ON tm.turn_row_id = t.id
      WHERE t.started_at < ? AND COALESCE(t.ended_at, ?) > ?`
    ).all(openAt, to, openAt, from) as {
      provider_id: string; model: string; started_at: number; ended_at: number;
      project_name: string | null; attribution_quality: string; closure_reason: string;
    }[];
    return aggregateAnalytics(
      sessions.map((session): SessionInterval => ({
        id: session.id, projectName: session.project_name, machineName: session.machine_name,
        start: session.started_at, end: session.ended_at, closureReason: session.closure_reason,
      })),
      turns.map((turn): TurnInterval => ({
        providerId: turn.provider_id, model: turn.model, projectName: turn.project_name,
        start: turn.started_at, end: turn.ended_at,
        attributionQuality: turn.attribution_quality, closureReason: turn.closure_reason,
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
    const analytics = analyzeWindow(from, to, to, timeZone);
    // The comparison window is the same length immediately before this one.
    // "All time" starts at the first row, so nothing precedes it to compare.
    const before = range === "all" ? null : analyzeWindow(from - (to - from), from, to, timeZone);
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
    getActivityStatus() { return { active: openSessions.size > 0 } },
    getSummary({ range, timezone }) { return computeSummary(range, timezone) },
  });
  bb.cli.register({
    name: "wakatime", summary: "Show honest interval-derived bb agent activity",
    commands: [
      { name: "today", summary: "Today's agent activity", usage: "bb wakatime today" },
      { name: "week", summary: "The last 7 calendar days", usage: "bb wakatime week" },
    ],
    async run(argv) {
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

  try { await reconcile() }
  catch (error) { bb.log.warn(`startup reconciliation failed: ${String(error)}`) }
  bb.background.service("reconciler", {
    async start(signal) {
      statements.setHeartbeat.run(String(Date.now()));
      while (!signal.aborted) {
        await sleep(HEARTBEAT_MS, signal);
        if (signal.aborted) break;
        statements.setHeartbeat.run(String(Date.now()));
        try { await reconcile() }
        catch (error) { bb.log.warn(`periodic reconciliation failed: ${String(error)}`) }
      }
    },
  });
  bb.onDispose(() => {
    const now = Date.now();
    for (const poller of pollers.values()) clearInterval(poller);
    pollers.clear();
    for (const threadId of openSessions.keys()) closeThreadIntervals(threadId, now, "plugin-dispose");
    openSessions.clear();
    statements.setHeartbeat.run(String(now));
  });
  bb.log.info("wakatime analytics v2 loaded");
}
