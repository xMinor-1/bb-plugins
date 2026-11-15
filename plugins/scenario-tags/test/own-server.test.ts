import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import { CATALOG_JSON } from "./fixtures";

async function load(scenarios = CATALOG_JSON) {
  const { bb, harness } = createFakePluginHost({ settings: { scenarios } });
  await plugin(bb);
  const tool = harness.registrations.agentTools.find((record) => record.name === "scenario_save")!;
  const ctx = { threadId: "t1", projectId: "p1", signal: new AbortController().signal };
  return { harness, tool, ctx };
}

const INVOICE = {
  label: "Invoice check",
  description: "Check an invoice against the contract",
  fields: [
    { id: "invoice", label: "Invoice", type: "attachment", required: true, answer: "attached" },
    { id: "party", label: "Counterparty", type: "text", required: true },
  ],
  prompt: "Check the attached invoice.\nCounterparty: {{party}}\nInvoice: {{invoice}}",
};

const text = (result: unknown) => (typeof result === "string" ? result : JSON.stringify(result));

async function waitForInteraction(harness: Awaited<ReturnType<typeof load>>["harness"]) {
  for (let i = 0; i < 50 && harness.inspection.pendingInteractions.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return harness.inspection.pendingInteractions[0]!;
}

describe("scenario_save", () => {
  it("is offered to agents with the plugin's skill", async () => {
    const { harness, tool } = await load();
    expect(tool.description).toMatch(/preview/);
    const config = harness.registrations.agentConfigurationProvider!({} as never);
    expect(config.tools).toEqual(["scenario_save"]);
  });

  it("shows a preview and saves only after the person confirms", async () => {
    const { harness, tool, ctx } = await load();
    const pending = tool.execute(tool.parse(INVOICE).ok ? (tool.parse(INVOICE) as { value: unknown }).value : INVOICE, ctx);
    const interaction = await waitForInteraction(harness);
    expect(interaction.rendererId).toBe("scenario-preview");
    expect(interaction.threadId).toBe("t1");
    const payload = interaction.payload as { scenario: { id: string; label: string; group: string }; replaces: string | null };
    expect(payload.scenario).toMatchObject({ label: "Invoice check", group: "mine-own" });
    expect(payload.scenario.id).toMatch(/^my-[0-9a-f]{8}$/);
    expect(payload.replaces).toBeNull();
    // Nothing is stored before the answer.
    expect(await harness.behavior.callRpc("own_list", null)).toEqual({ scenarios: [] });

    harness.behavior.submitInteraction(interaction.id, { save: true });
    expect(text(await pending)).toMatch(/Saved “Invoice check”/);
    const { scenarios } = (await harness.behavior.callRpc("own_list", null)) as { scenarios: Array<{ id: string; label: string }> };
    expect(scenarios.map((s) => s.label)).toEqual(["Invoice check"]);
    expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toContain("own-changed");
  });

  it("stores nothing when the person declines", async () => {
    const { harness, tool, ctx } = await load();
    const pending = tool.execute(INVOICE, ctx);
    const interaction = await waitForInteraction(harness);
    harness.behavior.submitInteraction(interaction.id, { save: false });
    expect(text(await pending)).toMatch(/did not save/);
    expect(await harness.behavior.callRpc("own_list", null)).toEqual({ scenarios: [] });
  });

  it("changes an own scenario in place by id and names it in the preview", async () => {
    const { harness, tool, ctx } = await load();
    const first = tool.execute(INVOICE, ctx);
    harness.behavior.submitInteraction((await waitForInteraction(harness)).id, { save: true });
    await first;
    const [saved] = ((await harness.behavior.callRpc("own_list", null)) as { scenarios: Array<{ id: string }> }).scenarios;

    const second = tool.execute({ ...INVOICE, id: saved!.id, label: "Invoice vs contract" }, ctx);
    for (let i = 0; i < 50 && harness.inspection.pendingInteractions.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    const interaction = harness.inspection.pendingInteractions.at(-1)!;
    expect((interaction.payload as { replaces: string }).replaces).toBe("Invoice check");
    harness.behavior.submitInteraction(interaction.id, { save: true });
    await second;
    const after = ((await harness.behavior.callRpc("own_list", null)) as { scenarios: Array<{ id: string; label: string }> }).scenarios;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: saved!.id, label: "Invoice vs contract" });
  });

  it("rejects a prompt that uses a field it does not have, and an unknown id", async () => {
    const { tool, ctx } = await load();
    const bad = await tool.execute({ ...INVOICE, prompt: "{{period}}" }, ctx);
    expect(text(bad)).toMatch(/not valid.*period/);
    const unknown = await tool.execute({ ...INVOICE, id: "my-nothere" }, ctx);
    expect(text(unknown)).toMatch(/No own scenario/);
  });

  it("keeps own scenarios when the catalog setting changes, and deletes on request", async () => {
    const { harness, tool, ctx } = await load();
    const pending = tool.execute(INVOICE, ctx);
    harness.behavior.submitInteraction((await waitForInteraction(harness)).id, { save: true });
    await pending;
    await harness.behavior.setSettings({ scenarios: JSON.stringify({ scenarios: [{ id: "only", label: "Only" }] }) });
    const listed = ((await harness.behavior.callRpc("own_list", null)) as { scenarios: Array<{ id: string }> }).scenarios;
    expect(listed).toHaveLength(1);
    const check = await harness.behavior.runCli(["check"]);
    expect(check.stdout).toMatch(/1 own scenario/);
    expect(await harness.behavior.callRpc("own_delete", { id: listed[0]!.id })).toEqual({ removed: true });
    expect(await harness.behavior.callRpc("own_list", null)).toEqual({ scenarios: [] });
    expect(await harness.behavior.callRpc("own_delete", { id: listed[0]!.id })).toEqual({ removed: false });
  });

  it("drops stored entries that no longer pass the checks", async () => {
    const { bb, harness } = createFakePluginHost({ settings: { scenarios: CATALOG_JSON } });
    await plugin(bb);
    await bb.storage.kv.set("own-scenarios", [{ id: "my-ok", label: "OK", prompt: "x" }, { id: "my-bad", label: "" }, { id: "no-prefix", label: "X" }]);
    const listed = ((await harness.behavior.callRpc("own_list", null)) as { scenarios: Array<{ id: string }> }).scenarios;
    expect(listed.map((s) => s.id)).toEqual(["my-ok"]);
  });
});
