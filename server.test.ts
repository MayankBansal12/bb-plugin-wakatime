import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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
    const summary = await harness.behavior.callRpc("getSummary", { range: "today" });
    expect(summary).toMatchObject({
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
    const populated = await harness.behavior.callRpc("getSummary", { range: "today" }) as {
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
});
