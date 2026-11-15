import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import { CATALOG_JSON } from "./fixtures";

async function load(scenarios = CATALOG_JSON) {
  const { bb, harness } = createFakePluginHost({ settings: { scenarios } });
  await plugin(bb);
  return harness;
}

describe("server", () => {
  it("keeps the person's pins and returns to the catalog's pick on null", async () => {
    const harness = await load();
    expect(await harness.behavior.callRpc("pins_get", null)).toEqual({ own: null });
    const own = { pins: ["plain"], known: ["report-guide"] };
    await harness.behavior.callRpc("pins_set", { own });
    expect(await harness.behavior.callRpc("pins_get", null)).toEqual({ own });
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain("pins-changed");
    await harness.behavior.callRpc("pins_set", { own: null });
    expect(await harness.behavior.callRpc("pins_get", null)).toEqual({ own: null });
  });

  it("rejects malformed pins at the boundary", async () => {
    const harness = await load();
    await expect(harness.behavior.callRpc("pins_set", { own: { pins: "plain" } })).rejects.toThrow();
  });

  it("checks the catalog from the CLI", async () => {
    const harness = await load();
    const ok = await harness.behavior.runCli(["check"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/3 scenario\(s\) in 2 group\(s\)/);
    expect(ok.stdout).toMatch(/report-guide {2}Reports {2}\[reports\] {2}\(in the row\)/);

    const broken = await load(JSON.stringify({ scenarios: [{ id: "a", label: "" }] }));
    const result = await broken.behavior.runCli(["check", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).problems).toHaveLength(1);
  });

  it("drops own pins with reset-pins", async () => {
    const harness = await load();
    await harness.behavior.callRpc("pins_set", { own: { pins: [], known: [] } });
    expect((await harness.behavior.runCli(["reset-pins"])).exitCode).toBe(0);
    expect(await harness.behavior.callRpc("pins_get", null)).toEqual({ own: null });
  });
});
