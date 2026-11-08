// The config file the plugin writes for the masking proxy. The plugin owns
// where the proxy listens, where it forwards and how it logs; masking rules
// come from the proxy's built-in profile plus the admin's extra YAML.

const OWNED_KEYS = ["server", "upstream", "log"] as const;

export interface ProxyConfigInput {
  port: number;
  /** Where the agent would send its requests without the proxy (https). */
  upstream: string;
  /** Admin YAML appended as is: obfuscation rules, egress and so on. */
  extra: string;
}

/** A top-level key of the extra YAML that the plugin writes itself, or null. */
export function ownedKeyInExtra(extra: string): string | null {
  for (const key of OWNED_KEYS) {
    if (new RegExp(`^${key}\\s*:`, "mu").test(extra)) return key;
  }
  return null;
}

export function validateUpstream(upstream: string): string | null {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return `Upstream "${upstream}" is not a URL.`;
  }
  if (url.protocol !== "https:") return `Upstream "${upstream}" must use https.`;
  return null;
}

export function renderProxyConfig({ port, upstream, extra }: ProxyConfigInput): string {
  const owned = ownedKeyInExtra(extra);
  if (owned !== null) throw new Error(`Extra proxy configuration must not set "${owned}": the plugin writes it.`);
  const problem = validateUpstream(upstream);
  if (problem !== null) throw new Error(problem);
  // JSON strings are valid YAML double-quoted scalars.
  const lines = [
    "# Written by the bb Obfuscation Proxy plugin on every start; edits are lost.",
    "server:",
    `  addr: ${JSON.stringify(`127.0.0.1:${port}`)}`,
    '  write_timeout: "0s"',
    "upstream:",
    "  default: anthropic",
    "  routes:",
    "    anthropic:",
    `      base_url: ${JSON.stringify(upstream.replace(/\/+$/u, ""))}`,
    "log:",
    '  level: "info"',
    '  format: "json"',
  ];
  const tail = extra.trim();
  return `${lines.join("\n")}\n${tail === "" ? "" : `${tail}\n`}`;
}
