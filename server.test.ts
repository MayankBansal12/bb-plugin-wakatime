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
    await harness.lifecycle.dispose();
  });
});
