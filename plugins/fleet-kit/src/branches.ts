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
  /** Null while the person has only switched plugins and not picked a branch yet. */
  branch: string | null;
  /** Plugins the person turned on or off by hand; the rest follow the branch. */
  plugins: Record<string, boolean>;
  at: string;
}

/**
 * Before any choice: "all" — a machine that already had the build installs
 * everything as before and nothing is turned off; "wait" — a new machine
 * installs the common set and what every branch turns on, and the plugins
 * that differ between branches wait for the choice.
 */
export type BranchStart = "all" | "wait";

/** On, off, or held back until the person picks a branch. */
export type Wanted = "on" | "off" | "wait";

/** Where this machine stands: the person's choice and what Fleet Kit last applied. */
export interface BranchState {
  choice: BranchChoice | null;
  start: BranchStart;
  /** Each optional plugin as the last sync under an existing branch left it: what a dropped branch keeps. */
  applied: Record<string, boolean>;
}

export const noBranchState = (): BranchState => ({ choice: null, start: "all", applied: {} });

export function optionalIds(branches: Branches | undefined): Set<string> {
  return new Set((branches?.optional ?? []).map((entry) => entry.id));
}

/** Whether the person has picked a branch (it may since have left the build). */
export const picked = (choice: BranchChoice | null): choice is BranchChoice & { branch: string } => choice !== null && choice.branch !== null;

/** The chosen branch, or null when there is no choice or the build no longer has that branch. */
export function chosenBranch(branches: Branches | undefined, choice: BranchChoice | null): Branches["list"][number] | null {
  if (branches === undefined || !picked(choice)) return null;
  return branches.list.find((branch) => branch.id === choice.branch) ?? null;
}

/** The branch's default for an optional plugin: on unless the branch says off. */
export function branchDefault(branch: Branches["list"][number] | null, id: string): boolean {
  return branch?.plugins?.[id] ?? true;
}

/** The value every branch agrees on, or null when branches differ. */
export function commonDefault(branches: Branches, id: string): boolean | null {
  const values = new Set(branches.list.map((branch) => branchDefault(branch, id)));
  return values.size === 1 ? [...values][0]! : null;
}

/** Whether this machine gets a plugin. */
export function pluginWanted(branches: Branches | undefined, state: BranchState, id: string): Wanted {
  if (branches === undefined || !optionalIds(branches).has(id)) return "on";
  const { choice } = state;
  // The person's own switch wins, before and after a branch is picked.
  const own = choice?.plugins[id];
  if (own !== undefined) return own ? "on" : "off";
  if (!picked(choice)) {
    if (state.start === "all") return "on";
    // A new machine gets what every branch has; only what differs between branches waits for the choice.
    const same = commonDefault(branches, id);
    return same === null ? "wait" : same ? "on" : "off";
  }
  const branch = chosenBranch(branches, choice);
  // A branch the build dropped leaves everything as the person had it.
  const value = branch !== null ? branchDefault(branch, id) : (state.applied[id] ?? true);
  return value ? "on" : "off";
}

/** What the last sync applied, for a dropped branch to keep: updated only while the chosen branch exists. */
export function appliedNow(branches: Branches | undefined, state: BranchState): Record<string, boolean> {
  if (branches === undefined || !picked(state.choice) || chosenBranch(branches, state.choice) === null) return state.applied;
  const applied = { ...state.applied };
  for (const id of optionalIds(branches)) applied[id] = pluginWanted(branches, state, id) === "on";
  return applied;
}

/** The optional plugins this machine has now that picking `branch` would turn off, by title. */
export function turnsOff(branches: Branches, state: BranchState, branch: string): string[] {
  const next: BranchState = { ...state, choice: chooseBranch(branches, state.choice, branch) };
  return branches.optional
    .filter((entry) => pluginWanted(branches, state, entry.id) === "on" && pluginWanted(branches, next, entry.id) === "off")
    .map((entry) => entry.title);
}

/** The MCP servers' defaults under the chosen branch: the branch's own value, else the entry's `default`. */
export function mcpDefaults(manifest: Manifest, choice: BranchChoice | null): Record<string, boolean> {
  const branch = chosenBranch(manifest.branches, choice);
  return Object.fromEntries(manifest.mcp.map((server) => [server.id, branch?.mcp?.[server.id] ?? server.default]));
}

/**
 * A new choice of branch. Switches of plugins that differ between branches
 * start over from the new branch's defaults; the person's switches of plugins
 * every branch treats alike (the shared set) stay.
 */
export function chooseBranch(branches: Branches, previous: BranchChoice | null, branch: string, now: Date = new Date()): BranchChoice {
  if (!branches.list.some((entry) => entry.id === branch)) throw new Error(`The build has no branch "${branch}".`);
  const kept = Object.fromEntries(Object.entries(previous?.plugins ?? {}).filter(([id]) => commonDefault(branches, id) !== null));
  return { branch, plugins: kept, at: now.toISOString() };
}

/** Turn one optional plugin on or off within the current choice. */
export function togglePlugin(branches: Branches, choice: BranchChoice | null, id: string, on: boolean, now: Date = new Date()): BranchChoice {
  if (!optionalIds(branches).has(id)) throw new Error(`"${id}" is part of every build and cannot be turned off.`);
  return { branch: choice?.branch ?? null, plugins: { ...(choice?.plugins ?? {}), [id]: on }, at: now.toISOString() };
}
