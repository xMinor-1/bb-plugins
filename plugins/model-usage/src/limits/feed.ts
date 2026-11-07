// Limit figures handed over by a local tool, for the hours when the provider's
// own usage check is refused.
//
// The check bb runs for Claude Code (Anthropic's usage endpoint) is throttled
// per account and can stay refused for an hour at a time, while the same
// figures keep arriving in the rate-limit headers of every Claude Code request.
// This plugin makes no such requests. A tool that already makes them can write
// the figures to `limits-feed.json`, and the panel shows them, marked as backup
// figures, while the provider refuses. Without the file nothing changes.
//
// The file is looked up in this plugin's data directory first, then in the
// Usage Meter plugin's one, so a tool written for Usage Meter keeps working.
//
// The file, all times ISO 8601:
//   {
//     "fetchedAt": "2026-10-31T09:20:00Z",
//     "windows": [
//       { "label": "Current session", "usedPercent": 12, "resetsAt": "2026-10-31T13:00:00Z" },
//       { "label": "Weekly limit", "usedPercent": 21, "resetsAt": "2026-11-01T19:00:00Z" }
//     ]
//   }
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const FEED_FILE = "limits-feed.json";
/** Older figures are not passed off as current: the file's writer has stopped. */
export const FEED_MAX_AGE_MS = 15 * 60_000;

const feedSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(
    z.object({
      label: z.string().min(1),
      usedPercent: z.number().nonnegative(),
      resetsAt: z.string().nullable(),
    }),
  ),
});

export type LimitsFeed = z.infer<typeof feedSchema>;

/** The plugin's own data directory, then Usage Meter's next to it. */
export function feedDirs(ownDataDir: string): string[] {
  return [ownDataDir, path.join(path.dirname(ownDataDir), "usage-meter")];
}

async function readOne(dir: string, now: number): Promise<LimitsFeed | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, FEED_FILE), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = feedSchema.safeParse(json);
  if (!parsed.success || parsed.data.windows.length === 0) return null;
  const at = Date.parse(parsed.data.fetchedAt);
  if (!Number.isFinite(at) || now - at > FEED_MAX_AGE_MS || at - now > FEED_MAX_AGE_MS) return null;
  return parsed.data;
}

/** The freshest well-formed feed among `dirs`; null when none is fresh. */
export async function readLimitsFeed(dirs: string[], now = Date.now()): Promise<LimitsFeed | null> {
  let best: LimitsFeed | null = null;
  for (const dir of dirs) {
    const feed = await readOne(dir, now);
    if (feed && (!best || Date.parse(feed.fetchedAt) > Date.parse(best.fetchedAt))) best = feed;
  }
  return best;
}

/** The window kind a feed label stands for, so panels can label it themselves. */
export function feedWindowKind(label: string): "five-hour" | "weekly" | "custom" {
  const text = label.toLowerCase();
  if (/session|5.?h|five/.test(text)) return "five-hour";
  if (/week|7.?d/.test(text)) return "weekly";
  return "custom";
}
