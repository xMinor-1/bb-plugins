import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recreateInput } from "../src/restore.ts";

const base = {
  id: "auto_1",
  projectId: "proj_1",
  name: "Weekly report",
  enabled: false,
  trigger: { triggerType: "schedule", cron: "0 9 * * 1", timezone: "Europe/Moscow" },
  origin: "agent",
  createdByThreadId: "thr_1",
  nextRunAt: 1,
  runCount: 3,
};

describe("recreateInput", () => {
  it("keeps an agent automation's settings and drops bb's bookkeeping", async () => {
    const input = await recreateInput(
      {
        ...base,
        execution: { mode: "agent", prompt: "Do it", providerId: "claude-code", model: "m", reasoningLevel: "medium", permissionMode: "auto", environment: { type: "project-default" }, serviceTier: null },
      },
      async () => "",
    );
    assert.deepEqual(input, {
      projectId: "proj_1",
      name: "Weekly report",
      enabled: false,
      trigger: base.trigger,
      execution: { mode: "agent", prompt: "Do it", providerId: "claude-code", model: "m", reasoningLevel: "medium", permissionMode: "auto", environment: { type: "project-default" } },
      origin: "agent",
      createdByThreadId: "thr_1",
    });
  });

  it("reads a script back from its stored file", async () => {
    const input = await recreateInput(
      { ...base, createdByThreadId: null, execution: { mode: "script", storedScriptPath: "/s/script.sh", interpreter: "bash", timeoutMs: 30000, workingDirectory: { type: "automation-storage" }, resolvedWorkingDirectory: "/x" } },
      async (path) => (path === "/s/script.sh" ? "echo hi\n" : ""),
    );
    assert.deepEqual(input?.execution, { mode: "script", script: "echo hi\n", interpreter: "bash", timeoutMs: 30000, workingDirectory: { type: "automation-storage" } });
    assert.equal("createdByThreadId" in (input ?? {}), false);
  });

  it("gives up when the script or the stored data is gone", async () => {
    assert.equal(await recreateInput({ ...base, execution: { mode: "script", storedScriptPath: "/gone" } }, async () => Promise.reject(new Error("ENOENT"))), null);
    assert.equal(await recreateInput({ ...base, problem: "invalid-stored-data" }, async () => ""), null);
  });
});
