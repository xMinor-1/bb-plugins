import { describe, expect, it } from "vitest";
import { chooseBranch, mcpDefaults, pluginWanted, togglePlugin, type Branches } from "../src/branches.js";
import { checkManifest } from "../src/manifest.js";
import { clone, sampleManifest } from "./fixtures.js";

const branches: Branches = {
  optional: [{ id: "qlik", title: "Qlik" }, { id: "crm", title: "CRM" }, { id: "tracker", title: "Tracker" }],
  list: [
    { id: "business", title: "Business", plugins: { tracker: false } },
    { id: "dev", title: "Development", plugins: { qlik: false, crm: false } },
  ],
};

describe("what a machine gets", () => {
  it("the common set always, optional plugins by the branch and the person's switches", () => {
    const dev = { branch: "dev", plugins: { crm: true }, at: "" };
    expect(pluginWanted(branches, dev, "wait", "mail")).toBe("on");
    expect(pluginWanted(branches, dev, "wait", "qlik")).toBe("off");
    expect(pluginWanted(branches, dev, "wait", "crm")).toBe("on");
    expect(pluginWanted(branches, dev, "wait", "tracker")).toBe("on");
  });

  it("without a choice: everything on an old machine, optional plugins wait on a new one", () => {
    expect(pluginWanted(branches, null, "all", "qlik")).toBe("on");
    expect(pluginWanted(branches, null, "wait", "qlik")).toBe("wait");
    expect(pluginWanted(branches, null, "wait", "mail")).toBe("on");
    expect(pluginWanted(undefined, null, "wait", "qlik")).toBe("on");
  });

  it("a dropped branch keeps the person's switches and turns nothing else off", () => {
    const gone = { branch: "gone", plugins: { crm: false }, at: "" };
    expect(pluginWanted(branches, gone, "wait", "crm")).toBe("off");
    expect(pluginWanted(branches, gone, "wait", "qlik")).toBe("on");
  });

  it("a new branch starts from its defaults; a switch needs a branch and an optional plugin", () => {
    const picked = togglePlugin(branches, chooseBranch(branches, "business"), "tracker", true);
    expect(picked.plugins).toEqual({ tracker: true });
    expect(chooseBranch(branches, "dev").plugins).toEqual({});
    expect(() => chooseBranch(branches, "nope")).toThrow(/no branch/);
    expect(() => togglePlugin(branches, null, "qlik", false)).toThrow(/Pick a branch/);
    expect(() => togglePlugin(branches, picked, "mail", false)).toThrow(/every branch/);
  });

  it("MCP defaults follow the branch, else each entry's own", () => {
    const raw = clone(sampleManifest()) as Record<string, any>;
    raw.branches = { optional: [{ id: "notes", title: "Notes" }], list: [{ id: "dev", title: "Dev", mcp: { wiki: true } }, { id: "biz", title: "Biz" }] };
    const manifest = checkManifest(raw).manifest!;
    expect(mcpDefaults(manifest, { branch: "dev", plugins: {}, at: "" })).toEqual({ wiki: true });
    expect(mcpDefaults(manifest, { branch: "biz", plugins: {}, at: "" })).toEqual({ wiki: false });
    expect(mcpDefaults(manifest, null)).toEqual({ wiki: false });
  });
});
