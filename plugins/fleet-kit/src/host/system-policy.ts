// Reads OpenCode 2's system configuration (the level users and projects cannot
// override) and reports whether it restricts providers to the allowed list.
//
// Fleet Kit never writes these files: they need administrator rights. The
// installer places them; Fleet Kit only shows which protection is in place.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// jsonc-parser's default entry is a UMD build whose internal requires esbuild
// cannot follow; the ESM build bundles cleanly.
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { verifyEffectiveProviderPolicy } from "../shared/provider-policy.js";

export function systemConfigDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return "/Library/Application Support/opencode";
  if (platform === "win32") return join(env.ProgramData ?? "C:\\ProgramData", "opencode");
  return "/etc/opencode";
}

type Statement = { action: string; resource: string; effect: string };

/** Statements in the order OpenCode 2.2.5 builds them: legacy lists, experimental, policies. */
export function policyStatements(config: Record<string, unknown>): Statement[] {
  const statements: Statement[] = [];
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null);
  const enabled = list(config.enabled_providers);
  if (enabled !== null) {
    statements.push({ action: "provider.use", resource: "*", effect: "deny" });
    for (const id of enabled) statements.push({ action: "provider.use", resource: id, effect: "allow" });
  }
  for (const id of list(config.disabled_providers) ?? []) statements.push({ action: "provider.use", resource: id, effect: "deny" });
  const experimental = config.experimental;
  if (experimental && typeof experimental === "object" && Array.isArray((experimental as { policies?: unknown }).policies)) {
    statements.push(...((experimental as { policies: Statement[] }).policies));
  }
  if (Array.isArray(config.policies)) statements.push(...(config.policies as Statement[]));
  return statements;
}

export interface SystemPolicyState {
  directory: string;
  /** "verified": the system level allows only the approved providers. */
  state: "verified" | "absent" | "insufficient" | "unreadable";
}

export async function readSystemPolicy(allowedProviders: string[], directory = systemConfigDirectory()): Promise<SystemPolicyState> {
  const statements: Statement[] = [];
  let found = false;
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    let text: string;
    try {
      text = await readFile(join(directory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { directory, state: "unreadable" };
    }
    found = true;
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || value === null || typeof value !== "object" || Array.isArray(value)) return { directory, state: "unreadable" };
    statements.push(...policyStatements(value as Record<string, unknown>));
  }
  if (!found) return { directory, state: "absent" };
  const decision = verifyEffectiveProviderPolicy(allowedProviders.join(","), statements);
  return { directory, state: decision.state === "verified" ? "verified" : "insufficient" };
}
