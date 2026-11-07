import { describe, expect, it } from "vitest";
import { appliedNow, chooseBranch, commonDefault, mcpDefaults, pluginWanted, togglePlugin, turnsOff, type BranchChoice, type Branches, type BranchState } from "../src/branches.js";
import { createChoiceQueue } from "../src/choice-store.js";
import { checkManifest } from "../src/manifest.js";
import { clone, sampleManifest } from "./fixtures.js";

// mail: on in every branch (the shared set); reports and contacts: sales only; board: engineering only.
const branches: Branches = {
  optional: [
    { id: "mail", title: "Mail" },
    { id: "reports", title: "Reports" },
    { id: "contacts", title: "Contacts" },
    { id: "board", title: "Board" },
  ],
  list: [
    { id: "sales", title: "Sales", plugins: { board: false } },
    { id: "engineering", title: "Engineering", plugins: { reports: false, contacts: false } },
  ],
};
const state = (choice: BranchChoice | null, start: BranchState["start"] = "wait", applied: Record<string, boolean> = {}): BranchState => ({ choice, start, applied });
const choice = (branch: string | null, plugins: Record<string, boolean> = {}): BranchChoice => ({ branch, plugins, at: "" });

describe("what a machine gets", () => {
  it("the required set always, optional plugins by the branch and the person's switches", () => {
    const engineering = state(choice("engineering", { contacts: true }));
    expect(pluginWanted(branches, engineering, "fleet-kit")).toBe("on");
    expect(pluginWanted(branches, engineering, "reports")).toBe("off");
    expect(pluginWanted(branches, engineering, "contacts")).toBe("on");
    expect(pluginWanted(branches, engineering, "board")).toBe("on");
    expect(pluginWanted(branches, engineering, "mail")).toBe("on");
  });

  it("a new machine before a choice: what every branch has is on, what differs waits", () => {
    expect(pluginWanted(branches, state(null), "mail")).toBe("on");
    expect(pluginWanted(branches, state(null), "reports")).toBe("wait");
    expect(pluginWanted(branches, state(null), "board")).toBe("wait");
    expect(commonDefault(branches, "mail")).toBe(true);
    expect(commonDefault(branches, "board")).toBeNull();
  });

  it("the shared set can be switched off before a branch is picked", () => {
    const own = togglePlugin(branches, null, "mail", false);
    expect(own.branch).toBeNull();
    expect(pluginWanted(branches, state(own), "mail")).toBe("off");
    expect(pluginWanted(branches, state(own), "reports")).toBe("wait");
  });

  it("a machine that had the build keeps everything until a branch is picked", () => {
    expect(pluginWanted(branches, state(null, "all"), "board")).toBe("on");
    expect(pluginWanted(undefined, state(null), "reports")).toBe("on");
  });

  it("a dropped or renamed branch leaves every plugin as the person had it", () => {
    const sales = state(choice("sales"));
    const applied = appliedNow(branches, sales);
    expect(applied).toEqual({ mail: true, reports: true, contacts: true, board: false });
    const renamed: Branches = { ...branches, list: [{ ...branches.list[0]!, id: "sales-2" }, branches.list[1]!] };
    const after = state(choice("sales"), "wait", applied);
    expect(pluginWanted(renamed, after, "board")).toBe("off");
    expect(pluginWanted(renamed, after, "reports")).toBe("on");
    // Nothing to apply under a missing branch: the snapshot stays.
    expect(appliedNow(renamed, after)).toBe(applied);
  });

  it("a new branch resets switches of branch plugins and keeps switches of the shared set", () => {
    const before = choice("sales", { mail: false, board: true });
    const next = chooseBranch(branches, before, "engineering");
    expect(next).toMatchObject({ branch: "engineering", plugins: { mail: false } });
    expect(() => chooseBranch(branches, null, "nope")).toThrow(/no branch/);
    expect(() => togglePlugin(branches, next, "fleet-kit", false)).toThrow(/every build/);
  });

  it("lists by title what a branch would turn off", () => {
    expect(turnsOff(branches, state(null, "all"), "engineering")).toEqual(["Reports", "Contacts"]);
    expect(turnsOff(branches, state(null, "wait"), "engineering")).toEqual([]);
    expect(turnsOff(branches, state(choice("engineering")), "sales")).toEqual(["Board"]);
  });

  it("MCP defaults follow the branch, else each entry's own", () => {
    const raw = clone(sampleManifest()) as Record<string, any>;
    raw.branches = { optional: [{ id: "notes", title: "Notes" }], list: [{ id: "dev", title: "Dev", mcp: { wiki: true } }, { id: "biz", title: "Biz" }] };
    const manifest = checkManifest(raw).manifest!;
    expect(mcpDefaults(manifest, choice("dev"))).toEqual({ wiki: true });
    expect(mcpDefaults(manifest, choice("biz"))).toEqual({ wiki: false });
    expect(mcpDefaults(manifest, null)).toEqual({ wiki: false });
  });
});

describe("choice changes", () => {
  it("run one at a time, each on top of the previous one", async () => {
    let stored: BranchChoice | null = null;
    const slow = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const change = createChoiceQueue(
      {
        read: async () => {
          await slow(5);
          return stored;
        },
        write: async (value) => {
          await slow(5);
          stored = value;
        },
      },
      () => undefined,
    );
    await Promise.all([
      change((current) => ({ save: chooseBranch(branches, current, "sales"), result: null })),
      change((current) => ({ save: togglePlugin(branches, current, "mail", false), result: null })),
      change((current) => ({ save: togglePlugin(branches, current, "board", true), result: null })),
      change(() => {
        throw new Error("refused");
      }).catch(() => null),
      change((current) => ({ save: togglePlugin(branches, current, "reports", false), result: null })),
    ]);
    expect(stored).toMatchObject({ branch: "sales", plugins: { mail: false, board: true, reports: false } });
  });
});
