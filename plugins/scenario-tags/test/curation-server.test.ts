import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import { CATALOG, CATALOG_JSON } from "./fixtures";

async function load(scenarios = CATALOG_JSON) {
  const { bb, harness } = createFakePluginHost({ settings: { scenarios } });
  await plugin(bb);
  return harness;
}

type Curation = { hidden: string[]; seen: string[] | null };
const curationSignals = (harness: Awaited<ReturnType<typeof load>>) =>
  harness.inspection.realtimeSignals.filter((signal) => signal.channel === "curation-changed").length;

describe("curation on the server", () => {
  it("sets the baseline at load, so the starting catalog is not new", async () => {
    const harness = await load();
    expect(await harness.behavior.callRpc("curation_get", null)).toEqual({ hidden: [], seen: ["report-guide", "contract-check", "plain"] });
    expect(curationSignals(harness)).toBe(0);
  });

  it("waits for a catalog before it sets the baseline", async () => {
    const harness = await load("");
    expect(await harness.behavior.callRpc("curation_get", null)).toEqual({ hidden: [], seen: null });
    await harness.behavior.setSettings({ scenarios: CATALOG_JSON });
    expect(((await harness.behavior.callRpc("curation_get", null)) as Curation).seen).toHaveLength(3);
  });

  it("hides and shows again, signalling only on a change", async () => {
    const harness = await load();
    await harness.behavior.callRpc("curation_update", { hide: ["plain"] });
    expect(curationSignals(harness)).toBe(1);
    await harness.behavior.callRpc("curation_update", { hide: ["plain"] });
    await harness.behavior.callRpc("curation_get", null);
    expect(curationSignals(harness)).toBe(1);
    expect(((await harness.behavior.callRpc("curation_update", { unhide: ["plain"] })) as Curation).hidden).toEqual([]);
    expect(curationSignals(harness)).toBe(2);
  });

  it("keeps two hides sent at once", async () => {
    const harness = await load();
    await Promise.all([
      harness.behavior.callRpc("curation_update", { hide: ["plain"] }),
      harness.behavior.callRpc("curation_update", { hide: ["contract-check"] }),
    ]);
    expect(((await harness.behavior.callRpc("curation_get", null)) as Curation).hidden.sort()).toEqual(["contract-check", "plain"]);
  });

  it("keeps hidden, pins and seen across a restart and a catalog update", async () => {
    const harness = await load();
    await harness.behavior.callRpc("curation_update", { hide: ["plain"] });
    await harness.behavior.callRpc("pins_set", { own: { pins: ["contract-check"], known: ["report-guide"] } });
    const restarted = await harness.lifecycle.reload(plugin);
    const updated = { ...CATALOG, scenarios: [...CATALOG.scenarios, { id: "added", label: "Added later" }] };
    await restarted.harness.behavior.setSettings({ scenarios: JSON.stringify(updated) });
    expect(await restarted.harness.behavior.callRpc("pins_get", null)).toEqual({ own: { pins: ["contract-check"], known: ["report-guide"] } });
    const curation = (await restarted.harness.behavior.callRpc("curation_get", null)) as Curation;
    expect(curation.hidden).toEqual(["plain"]);
    expect(curation.seen).not.toContain("added");

    const check = await restarted.harness.behavior.runCli(["check"]);
    expect(check.stdout).toMatch(/plain {2}Plain {2}\(hidden\)/);
    expect(check.stdout).toMatch(/added {2}Added later {2}\(new\)/);
    expect(check.stdout).toMatch(/contract-check {2}Contract check {2}\[contracts\] {2}\(in the row\)/);
    expect(check.stdout).toMatch(/1 hidden: plain\./);
    const json = JSON.parse((await restarted.harness.behavior.runCli(["check", "--json"])).stdout);
    expect(json).toMatchObject({ hidden: ["plain"], new: ["added"], row: ["contract-check"] });
  });

  it("shows hidden scenarios again from the CLI", async () => {
    const harness = await load();
    await harness.behavior.callRpc("curation_update", { hide: ["plain", "report-guide"] });
    const missing = await harness.behavior.runCli(["unhide", "contract-check"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/not hidden/);
    expect((await harness.behavior.runCli(["unhide", "plain"])).stdout).toBe("Shown again: plain.");
    expect(((await harness.behavior.callRpc("curation_get", null)) as Curation).hidden).toEqual(["report-guide"]);
    expect((await harness.behavior.runCli(["unhide", "--all"])).exitCode).toBe(0);
    expect(((await harness.behavior.callRpc("curation_get", null)) as Curation).hidden).toEqual([]);
    expect((await harness.behavior.runCli(["unhide", "--all"])).stdout).toBe("Nothing is hidden.");
    expect((await harness.behavior.runCli(["check"])).stdout).toMatch(/Nothing is hidden\./);
  });

  it("rejects malformed changes at the boundary", async () => {
    const harness = await load();
    await expect(harness.behavior.callRpc("curation_update", { hide: "plain" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("curation_update", { hide: ["x".repeat(65)] })).rejects.toThrow();
  });
});
