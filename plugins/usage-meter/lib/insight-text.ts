// lib/insight-text.ts — the wording of the Claude Code usage summary.
//
// These strings are not ours to improve: they are the ones the Claude Code
// extension for VS Code prints for the same numbers, quoted exactly, down to
// the typographic apostrophe (U+2019), the middle dot (U+00B7), the em dash
// (U+2014) and the ellipsis (U+2026). The page computes the figures with the
// same formulas, so it has no business phrasing the conclusions differently —
// a user comparing the two windows should see one product, not two opinions.
import type { BehaviorKey } from "../usage-scan";

/** Section heading. The apostrophe is U+2019, not ASCII. */
export const SECTION_TITLE = "What’s contributing to your limits usage?";

/** Always true, and always worth saying before any percentage. */
export const SCOPE_DISCLAIMER =
  "Approximate, based on local sessions on this machine — does not include other devices or claude.ai";

/** The one warning that keeps the percentages from being read as a pie chart. */
export function windowDisclaimer(window: "day" | "week"): string {
  return `Last ${window === "day" ? "24h" : "7d"} · these are independent characteristics of your usage, not a breakdown`;
}

/** Shown when no behaviour cleared the threshold. */
export function nothingOverText(minPercent: number): string {
  return `Nothing over ${minPercent}% in this period — try the other window.`;
}

export const LOADING_TEXT = "Loading usage data…";

/** Attribution has its own empty state: it fills up as skills and agents run. */
export const ATTRIBUTION_EMPTY_TITLE = "Skills, subagents, plugins, and MCP servers";
export const ATTRIBUTION_EMPTY_HINT = "No attribution data yet · accumulates as you use Claude";

/** Right-hand column of every attribution table. */
export const ATTRIBUTION_VALUE_HEADER = "% of usage";
/** Rows per attribution table; the rest collapse into one line. */
export const ATTRIBUTION_MAX_ROWS = 8;

/** "… 3 more" — the tail of a table that did not fit. */
export function moreText(count: number): string {
  return `… ${count} more`;
}

/** A behaviour: what it claims, and what to do about it. */
interface BehaviorText {
  claim: (pct: number) => string;
  advice: string;
}

export const BEHAVIOR_TEXT: Record<BehaviorKey, BehaviorText> = {
  cache_miss: {
    claim: (pct) => `${pct}% of your usage hit a >100k-token cache miss`,
    advice:
      "Uncached input is expensive, and often happens when sending a message to a session that has gone idle. /compact before stepping away keeps the cold-start small.",
  },
  long_context: {
    claim: (pct) => `${pct}% of your usage was at >150k context`,
    advice:
      "Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.",
  },
  subagent_heavy: {
    claim: (pct) => `${pct}% of your usage came from subagent-heavy sessions`,
    advice:
      "Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper model for simpler subagents.",
  },
  high_parallel: {
    claim: (pct) => `${pct}% of your usage was while 4+ sessions ran in parallel`,
    advice:
      "All sessions share one limit. If you don't need them all at once, queueing uses it more evenly.",
  },
  cron: {
    claim: (pct) => `${pct}% of your usage came from sessions active for 8+ hours`,
    advice:
      "These are often background/loop sessions. Continuous usage can add up quickly so make sure it is intentional.",
  },
};

/** The four attribution groups, in the order the extension lists them. */
export type AttributionGroup = "skills" | "agents" | "plugins" | "mcp_servers";

interface AttributionText {
  /** Table heading. */
  title: string;
  /** Row label — skills are printed with the slash the transcript does not store. */
  label: (name: string) => string;
  /** The sentence for the top row, shown only once it clears the threshold. */
  claim: (pct: number, name: string) => string;
  advice: string;
}

export const ATTRIBUTION_TEXT: Record<AttributionGroup, AttributionText> = {
  skills: {
    title: "Skills",
    label: (name) => `/${name}`,
    claim: (pct, name) => `${pct}% of your usage came from /${name}`,
    advice:
      "Heavy skills can be scoped down or run with a cheaper model via skill frontmatter.",
  },
  agents: {
    title: "Subagents",
    label: (name) => name,
    claim: (pct, name) => `${pct}% of your usage came from subagents under "${name}"`,
    advice:
      "If this runs frequently, consider configuring its subagents with a cheaper model or tightening their prompts.",
  },
  plugins: {
    title: "Plugins",
    label: (name) => name,
    claim: (pct, name) => `${pct}% of your usage came from the plugin "${name}"`,
    advice:
      "Review what this plugin contributes — its agents, skills, and MCP tools all count toward your limit.",
  },
  mcp_servers: {
    title: "MCP servers",
    label: (name) => name,
    claim: (pct, name) => `${pct}% of your usage came from the MCP server "${name}"`,
    advice:
      "MCP tool results stay in context for the rest of the session. /compact to flush them, or disable servers you don't need.",
  },
};
