import { describe, expect, it } from "vitest";
import { checkManifest } from "../src/manifest.js";
import { agentBuildOf, consentKey, keptAgents, normalizeAgentBuild, normalizeChoice, ownAgentsOn, skillInstructions, skillsFor, type AgentBuild } from "../src/own-agents.js";
import { answerOf, macScript, oneAtATime, systemConfirmWindow, windowsScript, type ConfirmWindow } from "../src/host/confirm-window.js";
import { clone, sampleManifest } from "./fixtures.js";

const own = { providers: ["claude-code", "codex"], warning: "Your agent reads what this bb holds.", delegate: { provider: "acp-opencode", model: "corp/big-model" } };
const skill = (name: string, audience?: "allowed" | "own" | "all") => ({ id: name, name, description: `About ${name}.`, body: `# ${name}\nSteps.`, ...(audience ? { audience } : {}) });

function withOwn(extra: Record<string, unknown> = {}): Record<string, any> {
  const manifest = clone(sampleManifest()) as Record<string, any>;
  manifest.agents = { allowed: ["acp-opencode"] };
  manifest.ownAgents = clone(own);
  Object.assign(manifest, extra);
  return manifest;
}

describe("ownAgents in the manifest", () => {
  it("is accepted with agents.allowed, and the delegate among them", () => {
    const result = checkManifest(withOwn());
    expect(result.errors).toEqual([]);
    expect(result.manifest?.ownAgents?.providers).toEqual(["claude-code", "codex"]);
  });

  it("refuses own agents without agents.allowed, or already allowed, or listed twice", () => {
    const noAgents = withOwn();
    delete noAgents.agents;
    expect(checkManifest(noAgents).errors.join("\n")).toContain("ownAgents: needs agents.allowed");
    const overlap = withOwn();
    overlap.ownAgents.providers = ["acp-opencode", "codex", "codex"];
    const errors = checkManifest(overlap).errors.join("\n");
    expect(errors).toContain('"acp-opencode" is already in agents.allowed');
    expect(errors).toContain("ownAgents.providers: an agent is listed twice");
  });

  it("refuses a delegate outside agents.allowed or a model outside allowedProviders", () => {
    const manifest = withOwn();
    manifest.ownAgents.delegate = { provider: "codex-x", model: "other/model" };
    const errors = checkManifest(manifest).errors.join("\n");
    expect(errors).toContain('ownAgents.delegate.provider: "codex-x" is not in agents.allowed');
    expect(errors).toContain('ownAgents.delegate.model: provider "other" is not in allowedProviders');
  });

  it("refuses unknown fields inside ownAgents and a missing warning", () => {
    const manifest = withOwn();
    manifest.ownAgents.surprise = 1;
    delete manifest.ownAgents.warning;
    expect(checkManifest(manifest).manifest).toBeNull();
  });

  it("keeps skills with an id alone, and wants name, description and body together", () => {
    expect(checkManifest(withOwn({ skills: [{ id: "old" }] })).errors).toEqual([]);
    const half = checkManifest(withOwn({ skills: [{ id: "half", name: "half", body: "text" }] }));
    expect(half.errors.join("\n")).toContain("skills.half: name, description and body go together");
    const twice = checkManifest(withOwn({ skills: [skill("same"), { ...skill("same"), id: "other" }] }));
    expect(twice.errors.join("\n")).toContain('the name "same" is used twice');
  });

  it("warns about a skill for own agents in a build without them", () => {
    const manifest = withOwn({ skills: [skill("corp", "own")] });
    delete manifest.ownAgents;
    expect(checkManifest(manifest).warnings).toContain("skills.corp: for own agents, but the build has no ownAgents; no agent gets it");
  });
});

describe("branding in the manifest", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  it("accepts a name, an SVG logo and the plugins it replaces", () => {
    const manifest = withOwn({ branding: { appName: "Example", logoSvg: svg, replaces: ["app-branding"] } });
    expect(checkManifest(manifest).errors).toEqual([]);
  });
  it("refuses a logo that is not SVG, unknown fields, and replacing a plugin it still installs or itself", () => {
    expect(checkManifest(withOwn({ branding: { logoSvg: "<img src=x>" } })).manifest).toBeNull();
    expect(checkManifest(withOwn({ branding: { colour: "red" } })).manifest).toBeNull();
    const installed = withOwn({ branding: { replaces: ["notes", "fleet-kit"] } });
    const errors = checkManifest(installed).errors.join("\n");
    expect(errors).toContain('branding.replaces: "notes" is also in plugins');
    expect(errors).toContain("branding.replaces: Fleet Kit cannot remove itself");
  });
});

describe("own agents and build skills", () => {
  const build = (): AgentBuild => {
    const result = checkManifest(withOwn({ skills: [skill("tools"), skill("corp", "own"), skill("shared", "all"), { id: "old" }] }));
    expect(result.errors).toEqual([]);
    return agentBuildOf(result.manifest!);
  };
  const on = { on: true, at: "2026-11-07T10:00:00.000Z", key: consentKey(own) };
  const off = { on: false, at: "2026-11-07T11:00:00.000Z" };

  it("keeps only the build's agents until the person turns own agents on", () => {
    const { allowed, own: block } = build();
    expect(keptAgents(allowed, block, null)).toEqual(["acp-opencode"]);
    expect(keptAgents(allowed, block, off)).toEqual(["acp-opencode"]);
    expect(keptAgents(allowed, block, on)).toEqual(["acp-opencode", "claude-code", "codex"]);
    // A build that stops offering them takes them back, whatever the person chose.
    expect(keptAgents(allowed, null, on)).toEqual(["acp-opencode"]);
    expect(ownAgentsOn(null, on)).toBe(false);
  });

  it("holds a yes only for the warning and agents the person saw", () => {
    expect(ownAgentsOn(own, on)).toBe(true);
    // The text changed.
    expect(ownAgentsOn({ ...own, warning: `${own.warning} More.` }, on)).toBe(false);
    // An agent was added.
    expect(ownAgentsOn({ ...own, providers: [...own.providers, "cursor"] }, on)).toBe(false);
    // A yes saved before the key existed, or with another key.
    expect(ownAgentsOn(own, { on: true, at: on.at })).toBe(false);
    expect(ownAgentsOn(own, { ...on, key: "0".repeat(64) })).toBe(false);
    // The title and the delegate are not what the person agreed to: changing them keeps the yes.
    expect(ownAgentsOn({ ...own, title: "Other", delegate: { provider: "acp-opencode", model: "corp/small-model" } }, on)).toBe(true);
    expect(keptAgents(["acp-opencode"], { ...own, providers: [...own.providers, "cursor"] }, on)).toEqual(["acp-opencode"]);
  });

  it("reads broken storage as off and offers nothing from a block without agents", () => {
    expect(normalizeAgentBuild(null)).toEqual({ allowed: [], own: null, skills: [] });
    expect(normalizeAgentBuild("x").own).toBeNull();
    expect(normalizeAgentBuild({ allowed: ["acp-opencode"], own: { warning: "w" }, skills: [] }).own).toBeNull();
    expect(normalizeAgentBuild({ allowed: ["acp-opencode"], own: { providers: [], warning: "w" } }).own).toBeNull();
    expect(normalizeAgentBuild({ allowed: ["acp-opencode"], own: { providers: ["codex"] } }).own).toBeNull();
    expect(normalizeAgentBuild({ allowed: "acp-opencode", skills: [{ id: "a" }, null] })).toEqual({ allowed: [], own: null, skills: [] });
    const broken = { providers: undefined, warning: "w" } as unknown as typeof own;
    expect(ownAgentsOn(broken, on)).toBe(false);
    expect(keptAgents(["acp-opencode"], broken, on)).toEqual(["acp-opencode"]);
    expect(normalizeChoice({ on: "yes", at: 1 })).toBeNull();
    expect(normalizeChoice({ on: true, at: on.at, key: on.key })).toEqual(on);
  });

  it("gives each agent only its audience's skills; own agents get theirs only once turned on", () => {
    const value = build();
    const names = (choice: { on: boolean; at: string; key?: string } | null, provider: string) => skillsFor(value, choice, provider).map((entry) => entry.name);
    expect(names(null, "acp-opencode")).toEqual(["tools", "shared"]);
    expect(names(on, "acp-opencode")).toEqual(["tools", "shared"]);
    expect(names(null, "claude-code")).toEqual([]);
    expect(names(off, "codex")).toEqual([]);
    expect(names(on, "claude-code")).toEqual(["corp", "shared"]);
    expect(names(on, "cursor")).toEqual([]);
  });

  it("lists the skills in the instructions with the tool to read them", () => {
    const value = build();
    expect(skillInstructions([])).toBeUndefined();
    const text = skillInstructions(skillsFor(value, on, "codex"))!;
    expect(text).toContain("`build_skill`");
    expect(text).toContain("- corp: About corp.");
    expect(text).not.toContain("Steps.");
    const long = skillInstructions(Array.from({ length: 10 }, (_, n) => ({ ...skill(`s${n}`), audience: "allowed" as const, description: "x".repeat(1000) })))!;
    expect(long.length).toBeLessThanOrEqual(4000);
  });
});

describe("the confirmation window", () => {
  const text = { title: "Turn on?", message: "Agents read «всё».\nSecond line", yes: "Turn on", no: "Cancel" };

  it("reads only a marked answer", () => {
    expect(answerOf("bb-fleet-kit:yes")).toBe("yes");
    expect(answerOf("noise\nbb-fleet-kit:no")).toBe("no");
    expect(answerOf("bb-fleet-kit:timeout")).toBe("timeout");
    expect(answerOf("bb-fleet-kit:nogui")).toBeNull();
    expect(answerOf("yes")).toBeNull();
  });

  it("keeps the scripts ASCII, with No as the default", () => {
    const mac = macScript(text);
    expect(/^[\x00-\x7f]*$/.test(mac)).toBe(true);
    expect(mac).toContain("defaultButton: data.no");
    expect(mac).toContain("\\u00ab");
    const windows = windowsScript(text);
    expect(/^[\x00-\x7f]*$/.test(windows)).toBe(true);
    const inner = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(windows)![1]!, "base64").toString("utf8");
    expect(inner).toContain("$form.AcceptButton = $no");
  });

  it("says unavailable on Linux without a desktop, and opens one window at a time", async () => {
    expect(await systemConfirmWindow("linux", {}).confirm(text)).toEqual({ ok: false, reason: "unavailable" });
    let release!: () => void;
    const slow: ConfirmWindow = { confirm: () => new Promise((resolve) => (release = () => resolve({ ok: true }))) };
    const single = oneAtATime(slow);
    const first = single.confirm(text);
    expect(await single.confirm(text)).toEqual({ ok: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ok: true });
  });
});
