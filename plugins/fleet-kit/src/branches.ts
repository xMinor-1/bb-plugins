// Build branches: sets of plugins the person picks from on the First run page.
//
// The manifest's `branches` block names the optional plugins and, for each
// branch, which of them it turns on or off by default. The person picks a
// branch and may turn any optional plugin on or off; that choice lives on the
// machine and outlives manifest updates. Plugins outside `optional` are the
// common set: every machine gets them, whatever the choice.
//
// A plugin the choice turns off is not installed, and an installed one is
// turned off (bb's disable), never removed: its settings, secrets and data
// stay, and turning it on again brings it back as it was.
import type { Manifest } from "./manifest.js";

export type Branches = NonNullable<Manifest["branches"]>;

/** What the person chose, kept in Fleet Kit's storage. */
export interface BranchChoice {
  branch: string;
  /** Plugins the person turned on or off by hand; the rest follow the branch. */
  plugins: Record<string, boolean>;
  at: string;
}

/**
 * Before any choice: "all" — a machine that already had the build installs
 * everything as before and nothing is turned off; "wait" — a new machine
 * installs only the common set until the person picks a branch.
 */
export type BranchStart = "all" | "wait";

/** On, off, or held back until the person picks a branch. */
export type Wanted = "on" | "off" | "wait";

export function optionalIds(branches: Branches | undefined): Set<string> {
  return new Set((branches?.optional ?? []).map((entry) => entry.id));
}

/** The chosen branch, or null when there is no choice or the build no longer has that branch. */
export function chosenBranch(branches: Branches | undefined, choice: BranchChoice | null): Branches["list"][number] | null {
  if (branches === undefined || choice === null) return null;
  return branches.list.find((branch) => branch.id === choice.branch) ?? null;
}

/** The branch's default for an optional plugin: on unless the branch says off. */
export function branchDefault(branch: Branches["list"][number] | null, id: string): boolean {
  return branch?.plugins?.[id] ?? true;
}

/** Whether this machine gets a plugin. */
export function pluginWanted(branches: Branches | undefined, choice: BranchChoice | null, start: BranchStart, id: string): Wanted {
  if (branches === undefined || !optionalIds(branches).has(id)) return "on";
  if (choice === null) return start === "wait" ? "wait" : "on";
  const own = choice.plugins[id];
  if (own !== undefined) return own ? "on" : "off";
  // A branch the build dropped keeps the person's own switches and turns nothing else off.
  return branchDefault(chosenBranch(branches, choice), id) ? "on" : "off";
}

/** The MCP servers' defaults under the chosen branch: the branch's own value, else the entry's `default`. */
export function mcpDefaults(manifest: Manifest, choice: BranchChoice | null): Record<string, boolean> {
  const branch = chosenBranch(manifest.branches, choice);
  return Object.fromEntries(manifest.mcp.map((server) => [server.id, branch?.mcp?.[server.id] ?? server.default]));
}

/** A new choice of branch: the person's switches start over from the branch's defaults. */
export function chooseBranch(branches: Branches, branch: string, now: Date = new Date()): BranchChoice {
  if (!branches.list.some((entry) => entry.id === branch)) throw new Error(`The build has no branch "${branch}".`);
  return { branch, plugins: {}, at: now.toISOString() };
}

/** Turn one optional plugin on or off within the current choice. */
export function togglePlugin(branches: Branches, choice: BranchChoice | null, id: string, on: boolean, now: Date = new Date()): BranchChoice {
  if (choice === null) throw new Error("Pick a branch first.");
  if (!optionalIds(branches).has(id)) throw new Error(`"${id}" is part of every branch and cannot be turned off.`);
  return { branch: choice.branch, plugins: { ...choice.plugins, [id]: on }, at: now.toISOString() };
}
