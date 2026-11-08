// The person's own agents, and the build's skills for agents.
//
// A build allows a fixed list of agents (`agents.allowed`). It may also offer
// more (`ownAgents.providers`): Claude Code or Codex with the person's own
// account. They stay off until the person turns "Own agents" on and confirms
// the build's warning in a system window. Then Fleet Kit stops turning those
// agents off; every other agent is still turned off.
//
// Build skills come from the manifest (`skills[]` with a body). An agent gets
// a skill by its audience: `allowed` — the build's agents, `own` — the
// person's own agents once turned on, `all` — both. The agent sees the skill's
// name and description in its instructions and reads the body with the
// `build_skill` tool.
import { createHash } from "node:crypto";
import type { Manifest } from "./manifest.js";

export type OwnAgentsBlock = NonNullable<Manifest["ownAgents"]>;
export type BuildSkill = { id: string; name: string; description: string; audience: "allowed" | "own" | "all"; body: string };

/** What a sync saved for the agent configuration: read synchronously on every thread start. */
export interface AgentBuild {
  allowed: string[];
  own: OwnAgentsBlock | null;
  skills: BuildSkill[];
}

/**
 * The person's switch, kept on this machine. A yes holds only for the warning
 * and the agents the person saw: `key` is their hash, so a changed text, an
 * added agent or a block the build dropped needs a new window.
 */
export interface OwnAgentsChoice {
  on: boolean;
  /** When the person last confirmed or turned it off. */
  at: string;
  /** consentKey() of the block the person confirmed; absent when off. */
  key?: string;
}

/** The hash a yes is bound to: the warning's text and the list of agents, as the manifest has them. */
export function consentKey(own: OwnAgentsBlock): string {
  return createHash("sha256").update(JSON.stringify({ warning: own.warning, providers: own.providers })).digest("hex");
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** A saved block that lost its agents or warning (an older or broken save) offers nothing. */
function usableOwn(value: unknown): OwnAgentsBlock | null {
  if (value === null || typeof value !== "object") return null;
  const own = value as Record<string, unknown>;
  if (!isStrings(own.providers) || own.providers.length === 0 || typeof own.warning !== "string" || own.warning === "") return null;
  return value as OwnAgentsBlock;
}

/** What a sync saved, read back from storage: anything malformed counts as absent. */
export function normalizeAgentBuild(value: unknown): AgentBuild {
  if (value === null || typeof value !== "object") return emptyAgentBuild();
  const saved = value as Record<string, unknown>;
  const skills = Array.isArray(saved.skills)
    ? (saved.skills as unknown[]).filter((entry): entry is BuildSkill => {
        const skill = entry as Record<string, unknown> | null;
        return skill !== null && typeof skill === "object" && ["id", "name", "description", "body"].every((key) => typeof skill[key] === "string") && ["allowed", "own", "all"].includes(skill.audience as string);
      })
    : [];
  return { allowed: isStrings(saved.allowed) ? saved.allowed : [], own: usableOwn(saved.own), skills };
}

/** The saved switch, read back from storage: anything malformed counts as off. */
export function normalizeChoice(value: unknown): OwnAgentsChoice | null {
  if (value === null || typeof value !== "object") return null;
  const saved = value as Record<string, unknown>;
  if (typeof saved.on !== "boolean" || typeof saved.at !== "string") return null;
  return { on: saved.on, at: saved.at, ...(typeof saved.key === "string" ? { key: saved.key } : {}) };
}

export const emptyAgentBuild = (): AgentBuild => ({ allowed: [], own: null, skills: [] });

export function agentBuildOf(manifest: Manifest): AgentBuild {
  const skills: BuildSkill[] = [];
  for (const entry of manifest.skills ?? []) {
    if (typeof entry.body !== "string" || typeof entry.name !== "string" || typeof entry.description !== "string") continue;
    skills.push({ id: entry.id, name: entry.name, description: entry.description, audience: entry.audience ?? "allowed", body: entry.body });
  }
  return { allowed: manifest.agents?.allowed ?? [], own: manifest.ownAgents ?? null, skills };
}

/** Own agents are on only while the build offers them and the person said yes to this very warning and list. */
export function ownAgentsOn(own: OwnAgentsBlock | null | undefined, choice: OwnAgentsChoice | null | undefined): boolean {
  const usable = usableOwn(own);
  return usable !== null && choice?.on === true && choice.key === consentKey(usable);
}

/** The agents a sync keeps on: the build's, plus the person's own once turned on. */
export function keptAgents(allowed: readonly string[], own: OwnAgentsBlock | null | undefined, choice: OwnAgentsChoice | null | undefined): string[] {
  const kept = [...allowed];
  if (ownAgentsOn(own, choice)) for (const id of own!.providers) if (!kept.includes(id)) kept.push(id);
  return kept;
}

/** Which of the build's skills this agent gets. */
export function skillsFor(build: AgentBuild, choice: OwnAgentsChoice | null, providerId: string): BuildSkill[] {
  const isAllowed = build.allowed.includes(providerId);
  const isOwn = ownAgentsOn(build.own, choice) && build.own!.providers.includes(providerId);
  return build.skills.filter((skill) =>
    skill.audience === "all" ? isAllowed || isOwn : skill.audience === "own" ? isOwn : isAllowed,
  );
}

export const SKILL_TOOL = "build_skill";
const INSTRUCTIONS_MAX = 4000;

/** The section added to the agent's instructions: one line per skill, so the agent knows when to read one. */
export function skillInstructions(skills: readonly BuildSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = [
    "## Build skills",
    `This build ships skills for you. Before a task one describes, read it whole with the \`${SKILL_TOOL}\` tool (\`name\`), then follow it.`,
  ];
  for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`);
  const text = lines.join("\n");
  return text.length <= INSTRUCTIONS_MAX ? text : `${text.slice(0, INSTRUCTIONS_MAX - 1)}…`;
}
