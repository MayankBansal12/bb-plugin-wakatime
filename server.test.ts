import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

describe("plugin integration", () => {
  it("loads the additive schema and returns an honest empty summary", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "wakatime",
      sdk: {
        threads: {
          list: async () => [],
        },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("getActivityStatus", null)).resolves.toEqual({ active: false });
    const summary = await harness.behavior.callRpc("getSummary", {
      range: "today",
      timezone: "Asia/Kolkata",
    });
    expect(summary).toMatchObject({
      range: { timezone: "Asia/Kolkata" },
      workingMs: 0,
      agentRuntimeMs: 0,
      agentCoverageMs: 0,
      totalActiveMs: 0,
      totalComputeMs: 0,
      turnCount: 0,
      projects: [],
      models: [],
      machines: [],
      concurrency: {
        averageConcurrentTurns: 0,
        peakConcurrentTurns: 0,
        swarmTimeMs: 0,
      },
    });
    const cli = await harness.behavior.runCli(["today"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("working time (union): 0m");
    expect(cli.stdout).toContain("agent runtime (sum): 0m");

    const db = bb.storage.database();
    const now = Date.now();
    const session = db.prepare(`INSERT INTO sessions
      (thread_id, project_name, machine_name, started_at, ended_at)
      VALUES ('thread-model', 'Project', 'Machine', ?, ?)`
    ).run(now - 60_000, now);
    const turn = db.prepare(`INSERT INTO turns
      (thread_id, turn_id, session_id, provider_id, model, started_at, ended_at)
      VALUES ('thread-model', '1', ?, 'codex', 'gpt-test', ?, ?)`
    ).run(Number(session.lastInsertRowid), now - 50_000, now - 10_000);
    db.prepare(`INSERT INTO turn_metadata
      (turn_row_id, attribution_quality, closure_reason)
      VALUES (?, 'sampled-live', 'completed')`
    ).run(Number(turn.lastInsertRowid));
    const populated = await harness.behavior.callRpc("getSummary", {
      range: "today",
      timezone: "Asia/Kolkata",
    }) as {
      models: Array<Record<string, string | number>>;
    };
    expect(populated.models).toEqual([{
      providerId: "codex",
      model: "gpt-test",
      agentRuntimeMs: 40_000,
      computeMs: 40_000,
      turnCount: 1,
      sampledTurnCount: 1,
    }]);
    await harness.lifecycle.dispose();
  });

  it("replays an already-pending approval before inferring an active session", async () => {
    const now = Date.now();
    const turnStartedAt = now - 200;
    const pendingAt = now - 100;
    const events = [
      {
        seq: 10,
        type: "turn/started",
        createdAt: turnStartedAt,
        data: {},
      },
      {
        seq: 20,
        type: "system/interaction/lifecycle",
        createdAt: pendingAt,
        data: { interaction: { id: "approval-1", status: "pending" } },
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "wakatime",
      sdk: {
        threads: {
          list: async () => [],
          events: { list: async () => events as never },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thread-waiting", status: "active" }),
    });
    const db = bb.storage.database();
    await expect.poll(() => db.prepare(
      `SELECT ended_at FROM turns WHERE thread_id = 'thread-waiting'`,
    ).get()).toEqual({ ended_at: pendingAt });

    expect(db.prepare(
      `SELECT ended_at FROM sessions WHERE thread_id = 'thread-waiting'`,
    ).get()).toEqual({ ended_at: pendingAt });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM sessions
       WHERE thread_id = 'thread-waiting' AND ended_at IS NULL`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT closure_reason FROM turn_metadata
       WHERE turn_row_id = (SELECT id FROM turns WHERE thread_id = 'thread-waiting')`,
    ).get()).toEqual({ closure_reason: "interaction-pending" });
    expect(db.prepare(
      `SELECT active_turn_id, pending_interaction_ids FROM poll_cursors
       WHERE thread_id = 'thread-waiting'`,
    ).get()).toEqual({
      active_turn_id: "10",
      pending_interaction_ids: '["approval-1"]',
    });
    await harness.lifecycle.dispose();
  });

  it("falls back to the server timezone instead of failing on an unusable one", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "wakatime",
      sdk: { threads: { list: async () => [] } },
    });
    await plugin(bb);
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // A browser may report a zone this server's ICU does not know. That must
    // degrade to the server's own zone, not blank the whole dashboard.
    for (const timezone of ["", "Not/AZone", "Mars/Olympus_Mons"]) {
      const summary = await harness.behavior.callRpc("getSummary", { range: "today", timezone }) as {
        range: { timezone: string };
      };
      expect(summary.range.timezone).toBe(system);
    }

    // Omitting it entirely is still allowed, as the CLI does.
    const omitted = await harness.behavior.callRpc("getSummary", { range: "today" }) as {
      range: { timezone: string };
    };
    expect(omitted.range.timezone).toBe(system);

    // A recognised zone is honoured and echoed back verbatim.
    const kolkata = await harness.behavior.callRpc("getSummary", {
      range: "today",
      timezone: "Asia/Kolkata",
    }) as { range: { timezone: string } };
    expect(kolkata.range.timezone).toBe("Asia/Kolkata");
  });
});
