// Reads the masking proxy's JSON log lines (one object per line on stdout).
// Only metadata is logged there: the proxy never writes request bodies.

export type ProxyLogEvent =
  | { kind: "listening"; addr: string }
  | { kind: "masks"; inBytes: number; byCategory: Record<string, number> }
  | { kind: "request"; path: string; status: number; durationMs: number }
  | { kind: "error"; message: string }
  | { kind: "other" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function counts(value: unknown): Record<string, number> {
  const source = record(value);
  const result: Record<string, number> = {};
  if (source === null) return result;
  for (const [key, count] of Object.entries(source)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) result[key] = count;
  }
  return result;
}

export function parseProxyLogLine(line: string): ProxyLogEvent {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return trimmed === "" ? { kind: "other" } : { kind: "error", message: trimmed };
  let parsed: Record<string, unknown> | null;
  try {
    parsed = record(JSON.parse(trimmed));
  } catch {
    return { kind: "error", message: trimmed };
  }
  if (parsed === null) return { kind: "other" };
  const msg = typeof parsed.msg === "string" ? parsed.msg : "";
  if (msg === "listening" && typeof parsed.addr === "string") return { kind: "listening", addr: parsed.addr };
  if (msg === "detect.debug" && typeof parsed.in_bytes === "number") {
    return { kind: "masks", inBytes: parsed.in_bytes, byCategory: counts(parsed.by_category) };
  }
  if (msg === "upstream call" && typeof parsed.status === "number") {
    return {
      kind: "request",
      path: typeof parsed.path === "string" ? parsed.path : "",
      status: parsed.status,
      durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
    };
  }
  if (parsed.level === "ERROR") {
    const detail = typeof parsed.error === "string" ? `: ${parsed.error}` : "";
    return { kind: "error", message: `${msg}${detail}` };
  }
  return { kind: "other" };
}
