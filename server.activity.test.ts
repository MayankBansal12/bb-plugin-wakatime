import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './server.js';
import type { TurnLifecycleEvent } from './collector.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 12, 12);
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function setup() {
  const events = new Map<string, TurnLifecycleEvent[]>();
  const states = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const pending = new Set<string>();
  let listed: string[] = [];
  let failEvents = false;
  let failStatus = false;
  let failPageAfter: number | undefined;
  const state = (id: string) => states.get(id) ?? makeThreadResponse({
    id, status: 'active', runtime: { displayStatus: 'active', hostReconnectGraceExpiresAt: null },
  });
  let { bb, harness } = createFakePluginHost({
    pluginId: 'wakatime',
    sdk: { threads: {
      list: async ({ offset = 0, limit = 100 } = {}) => listed.slice(offset, offset + limit).map(state) as never,
      get: async ({ threadId }) => {
        if (failStatus) throw new Error('status unavailable');
        return state(threadId);
      },
      defaultExecutionOptions: async () => ({ model: 'test-model' }) as never,
      interactions: { list: async ({ threadId }) => pending.has(threadId) ? [{ id: 'approval', status: 'pending' }] as never : [] },
      events: { list: async ({ threadId, afterSeq }) => {
        if (failEvents || (failPageAfter !== undefined && Number(afterSeq ?? 0) >= failPageAfter)) throw new Error('history unavailable');
        return (events.get(threadId) ?? []).filter((e) => e.seq > Number(afterSeq ?? 0))
          .slice(0, 1000).map((e) => ({ ...e, data: e.interaction ? { interaction: e.interaction } : {} })) as never;
      } },
    } },
  });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  const summary = async () => await harness.behavior.callRpc('getSummary', { range: 'all', timezone: 'UTC' }) as {
    workingMs: number; agentRuntimeMs: number; agentCoverageMs: number;
    turnCount: number; projects: Array<{ name: string; workingMs: number }>;
    days: Array<{ workingMs: number }>; profile: { hours: number[] };
  };
  const active = async () => (await harness.behavior.callRpc('getActivityStatus', null) as { active: boolean }).active;
  const emit = async (name: 'thread.active' | 'thread.archived' | 'thread.deleted' | 'thread.idle' | 'thread.failed', id = 't') => {
    await harness.behavior.emitThreadEvent(name, { thread: state(id), lastAssistantText: null, error: null });
  };
  return {
    bb, harness, db, events, states, pending, summary, active, emit,
    reload: async () => { ({ bb, harness } = await harness.lifecycle.reload(plugin)); },
    list: (ids: string[]) => { listed = ids; },
    failEvents: (value: boolean) => { failEvents = value; },
    failStatus: (value: boolean) => { failStatus = value; },
    failPageAfter: (value?: number) => { failPageAfter = value; },
  };
}
const start = (seq: number, at: number): TurnLifecycleEvent => ({ seq, type: 'turn/started', createdAt: at });
const end = (seq: number, at: number): TurnLifecycleEvent => ({ seq, type: 'turn/completed', createdAt: at });
const interaction = (seq: number, at: number, status: string, id = 'approval'): TurnLifecycleEvent => ({
  seq, createdAt: at, type: 'system/interaction/lifecycle', interaction: { id, status },
});

// Drive the actual plugin, including SQLite, SDK event paging, status checks,
// reconciliation and RPC totals. No live BB threads or storage are touched.
describe('strict active-turn accounting', () => {
  it.each(['thread.archived', 'thread.deleted', 'thread.idle', 'thread.failed'] as const)(
    '%s cannot turn a month-old completed turn into a month of work', async (event) => {
      const f = await setup();
      f.events.set('t', [start(1, BASE - 31 * DAY), end(2, BASE - 31 * DAY + 1_000)]);
      await f.emit(event);
      expect(await f.summary()).toMatchObject({ workingMs: 1_000, agentRuntimeMs: 1_000 });
      expect(f.db.prepare('SELECT count(*) n FROM sessions WHERE ended_at IS NULL').get()).toEqual({ n: 0 });
      await f.emit(event); // duplicate notification and replay are idempotent
      expect(await f.summary()).toMatchObject({ workingMs: 1_000, turnCount: 1 });
    },
  );

  it('never counts gaps between completed historical turns', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - 31 * DAY), end(2, BASE - 31 * DAY + 1_000), start(3, BASE - DAY), end(4, BASE - DAY + 2_000)]);
    await f.emit('thread.archived');
    const result = await f.summary();
    expect(result.workingMs).toBe(3_000);
    expect(result.profile.hours.reduce((a, b) => a + b, 0)).toBe(3_000);
    expect(Math.max(...result.days.map((d) => d.workingMs))).toBe(2_000);
  });

  it('requires a turn start even when the thread is active', async () => {
    const f = await setup();
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 0, turnCount: 0 });
    expect(await f.active()).toBe(false);
  });

  it('does not keep counting after completion even if status remains active', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 1_000);
    f.events.get('t')!.push(end(2, BASE + 1_000));
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 1_000 });
    expect(await f.active()).toBe(false);
  });

  it('unmatched historical starts are not charged through archiving', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - 31 * DAY)]);
    await f.emit('thread.archived');
    expect(await f.summary()).toMatchObject({ workingMs: 0, agentRuntimeMs: 0 });
  });

  it('a later start cannot fill in a missing completion', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - 31 * DAY), start(2, BASE - DAY), end(3, BASE - DAY + 1_000)]);
    await f.emit('thread.archived');
    expect(await f.summary()).toMatchObject({ workingMs: 1_000, agentRuntimeMs: 1_000 });
  });

  it('old unfinished history on an active thread starts counting only from observation', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - 31 * DAY)]);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 0 });
    vi.setSystemTime(BASE + 10_000);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 10_000 });
  });

  it.each(['host-reconnecting', 'waiting-for-host', 'stopping', 'idle'] as const)(
    'does not confirm an active-status thread whose runtime is %s', async (displayStatus) => {
      const f = await setup();
      f.events.set('t', [start(1, BASE)]);
      f.states.set('t', makeThreadResponse({ id: 't', status: 'active', runtime: { displayStatus, hostReconnectGraceExpiresAt: null } }));
      await f.emit('thread.active');
      vi.setSystemTime(BASE + DAY);
      await f.emit('thread.active');
      expect(await f.summary()).toMatchObject({ workingMs: 0 });
      expect(await f.active()).toBe(false);
    },
  );

  it('reconciliation catches a missed idle event and caps at the last confirmed time', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 5_000);
    await f.emit('thread.active');
    f.states.set('t', makeThreadResponse({ id: 't', status: 'idle' }));
    const service = f.harness.behavior.runService('reconciler');
    await vi.advanceTimersByTimeAsync(10_000);
    service.controller.abort();
    await service.done;
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
    expect(await f.active()).toBe(false);
  });

  it.each(['events', 'status'] as const)('failed %s checks stop time and cannot bridge an outage', async (kind) => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 5_000);
    await f.emit('thread.active');
    const fail = kind === 'events' ? f.failEvents : f.failStatus;
    fail(true);
    vi.setSystemTime(BASE + 10_000);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY);
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
    expect(await f.active()).toBe(false);
    fail(false);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY + 2_000);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 7_000 });
  });

  it('open totals do not extrapolate to now and expire without new observations', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 5_000);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY);
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
    expect(await f.active()).toBe(false);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
  });

  it('excludes pending and resolving time, resuming only after the last matching resolution', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - 10_000), interaction(2, BASE - 9_000, 'pending'),
      interaction(3, BASE - 8_000, 'resolving'), interaction(4, BASE - 7_000, 'pending', 'other'),
      interaction(5, BASE - 6_000, 'resolved'), interaction(6, BASE - 2_000, 'resolved', 'other'), end(7, BASE - 1_000)]);
    await f.emit('thread.archived');
    expect(await f.summary()).toMatchObject({ workingMs: 2_000 });
  });

  it('live pending interactions pause even when their lifecycle event was missed', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 5_000);
    await f.emit('thread.active');
    f.pending.add('t');
    vi.setSystemTime(BASE + 10_000);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + DAY);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
    expect(await f.active()).toBe(false);
  });

  it('interrupted approvals and unrelated resolutions cannot revive a stopped turn', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE - DAY), interaction(2, BASE - DAY + 1_000, 'pending'),
      interaction(3, BASE - DAY + 2_000, 'interrupted'), interaction(4, BASE - 5_000, 'resolved')]);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 1_000 });
    expect(await f.active()).toBe(false);
  });

  it('drains a completion on page two before publishing live activity', async () => {
    const f = await setup();
    const history = Array.from({ length: 1000 }, (_, i) => interaction(i + 1, BASE - DAY, 'resolved', `unknown-${i}`));
    history[999] = start(1000, BASE - DAY);
    history.push(end(1001, BASE - DAY + 1_000));
    f.events.set('t', history);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 1_000 });
    expect(await f.active()).toBe(false);
  });

  it('a failed later event page never makes its unfinished historical turn live', async () => {
    const f = await setup();
    const history = Array.from({ length: 1000 }, (_, i) => interaction(i + 1, BASE - DAY, 'resolved', `unknown-${i}`));
    history[999] = start(1000, BASE - DAY);
    history.push(end(1001, BASE - DAY + 1_000));
    f.events.set('t', history);
    f.failPageAfter(1000);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 0 });
    expect(await f.active()).toBe(false);
  });

  it('ignores inflated legacy sessions and unverified superseded turns without rewriting them', async () => {
    const f = await setup();
    const session = f.db.prepare(`INSERT INTO sessions (thread_id, project_name, started_at, ended_at)
      VALUES ('old', 'Old project', ?, ?)`).run(BASE - 31 * DAY, BASE);
    const good = f.db.prepare(`INSERT INTO turns (thread_id, turn_id, session_id, started_at, ended_at)
      VALUES ('old', '1', ?, ?, ?)`).run(Number(session.lastInsertRowid), BASE - DAY, BASE - DAY + 1_000);
    f.db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason)
      VALUES (?, 'historical-unknown', 'completed')`).run(Number(good.lastInsertRowid));
    const bad = f.db.prepare(`INSERT INTO turns (thread_id, turn_id, session_id, started_at, ended_at)
      VALUES ('old', '2', ?, ?, ?)`).run(Number(session.lastInsertRowid), BASE - 31 * DAY, BASE);
    f.db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason)
      VALUES (?, 'historical-unknown', 'superseded')`).run(Number(bad.lastInsertRowid));
    // The old long turn lacks a completion; only the short pair is supported.
    f.events.set('old', [start(1, BASE - DAY), end(3, BASE - DAY + 1_000)]);
    await f.harness.behavior.runCli(['recheck-history']);
    expect(await f.summary()).toMatchObject({ workingMs: 1_000, projects: [{ name: 'Old project', workingMs: 1_000 }] });
    expect(f.db.prepare('SELECT ended_at - started_at duration FROM sessions WHERE id = ?').get(session.lastInsertRowid))
      .toEqual({ duration: 31 * DAY });
  });

  it('rechecks legacy completed turns and removes historical approval waits without mutating source rows', async () => {
    const f = await setup();
    const turn = f.db.prepare(`INSERT INTO turns (thread_id, turn_id, started_at, ended_at)
      VALUES ('legacy-wait', '1', ?, ?)`).run(BASE - DAY, BASE - 1_000);
    f.db.prepare(`INSERT INTO turn_metadata (turn_row_id, attribution_quality, closure_reason)
      VALUES (?, 'sampled-live', 'completed')`).run(Number(turn.lastInsertRowid));
    f.events.set('legacy-wait', [start(1, BASE - DAY), interaction(2, BASE - DAY + 1_000, 'pending'),
      interaction(3, BASE - 3_000, 'resolving'), interaction(4, BASE - 2_000, 'resolved'), end(5, BASE - 1_000)]);
    expect(await f.summary()).toMatchObject({ workingMs: 0 }); // unverified legacy data stays excluded
    expect((await f.harness.behavior.runCli(['recheck-history'])).exitCode).toBe(0);
    expect(await f.summary()).toMatchObject({ workingMs: 2_000, agentRuntimeMs: 2_000 });
    await f.harness.behavior.runCli(['recheck-history']);
    expect(await f.summary()).toMatchObject({ workingMs: 2_000 });
    expect(f.db.prepare('SELECT ended_at - started_at duration FROM turns WHERE id = ?').get(turn.lastInsertRowid))
      .toEqual({ duration: DAY - 1_000 });
  });

  it('failed legacy verification remains excluded and retries without a partial repair', async () => {
    const f = await setup();
    f.db.prepare(`INSERT INTO turns (thread_id, turn_id, started_at, ended_at)
      VALUES ('legacy', '1', ?, ?)`).run(BASE - DAY, BASE - DAY + 1_000);
    f.events.set('legacy', [start(1, BASE - DAY), end(2, BASE - DAY + 1_000)]);
    f.failEvents(true);
    expect((await f.harness.behavior.runCli(['recheck-history'])).exitCode).toBe(1);
    expect(await f.summary()).toMatchObject({ workingMs: 0 });
    f.failEvents(false);
    expect((await f.harness.behavior.runCli(['recheck-history'])).exitCode).toBe(0);
    expect(await f.summary()).toMatchObject({ workingMs: 1_000 });
  });

  it('restart closes orphan turns without a session or heartbeat grace, then resumes from now', async () => {
    const f = await setup();
    f.events.set('t', [start(1, BASE)]);
    await f.emit('thread.active');
    vi.setSystemTime(BASE + 5_000);
    await f.emit('thread.active');
    // Make an orphan as older collectors could leave one behind.
    f.db.prepare("UPDATE turns SET session_id = NULL WHERE thread_id = 't'").run();
    vi.setSystemTime(BASE + DAY);
    await f.reload();
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 5_000 });
    vi.setSystemTime(BASE + DAY + 2_000);
    await f.emit('thread.active');
    expect(await f.summary()).toMatchObject({ workingMs: 7_000 });
  });

  it('transaction failures roll back sessions and turns with the cursor and retry cleanly', async () => {
    const f = await setup();
    f.db.exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON poll_cursors BEGIN SELECT RAISE(FAIL, 'injected'); END;`);
    f.events.set('t', [start(1, BASE - 2_000), end(2, BASE - 1_000)]);
    await f.emit('thread.archived');
    expect(f.db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM turns').get()).toEqual({ n: 0 });
    f.db.exec('DROP TRIGGER fail_cursor');
    await f.emit('thread.archived');
    expect(await f.summary()).toMatchObject({ workingMs: 1_000, turnCount: 1 });
  });

  it('parallel agents contribute unioned working time, not double counted time', async () => {
    const f = await setup();
    for (const id of ['a', 'b']) {
      f.events.set(id, [start(1, BASE - 2_000), end(2, BASE - 1_000)]);
      await f.emit('thread.archived', id);
    }
    expect(await f.summary()).toMatchObject({ workingMs: 1_000, agentRuntimeMs: 2_000, agentCoverageMs: 1_000 });
  });
});
