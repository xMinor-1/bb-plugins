// bb-plugin-model-usage — backend.
//
// Three kinds of figures, each with its own source and pace:
//  - plan limits: read from the usage sources bb's provider plugins publish
//    (src/limits/collector.ts), every five minutes and when a panel asks, with
//    a local limits file standing in for Claude Code while its check is refused;
//  - tokens per model: Claude Code's session logs on this machine
//    (src/claude/usage-scan.ts) and OpenCode's database on every machine bb
//    reaches (src/host.ts), every ten minutes and when a panel asks;
//  - Claude Code activity: the same session logs, summarised for the page.
// Every panel reads the same snapshots, so open tabs add no load on providers.
import path from "node:path";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contract";
import { usageScannerForPlugin, type UsageSummary } from "./src/claude/usage-scan";
import { LimitsCollector, CLAUDE_PROVIDER_ID } from "./src/limits/collector";
import { FEED_FILE, feedDirs, feedWindowKind, readLimitsFeed } from "./src/limits/feed";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
} from "./src/limits/source-contract";
import { OpencodeCollector, type StoredReading } from "./src/opencode/collector";
import type { TokenWindow, TokensSnapshot, ModelGroup } from "./src/shared/types";
import {
  arrangeGroups,
  claudeGroup,
  opencodeGroups,
  parsePrefixes,
  type ClaudeModelTotals,
} from "./src/tokens";

const MIN = 60_000;
/** Limits poll: the pace Usage Meter kept for a year without trouble. */
const LIMITS_POLL_MS = 5 * MIN;
/** OpenCode reads on every connected machine. */
const OPENCODE_POLL_MS = 10 * MIN;
/** A panel asking more often than this gets the figures already read. */
const OPENCODE_MIN_AGE_MS = 30_000;
/** How often the transcript scanner catches up with Claude Code's logs. */
const SCAN_MS = MIN;
const SOURCE_CALL_MS = 45_000;
const HOST_CALL_MS = 20_000;
const TOP_ROWS = 12;
const SUMMARY_TTL_MS = 3_000;
const CLAUDE_TTL_MS = 30_000;
const WINDOW_MS: Record<TokenWindow, number> = { "5h": 5 * 60 * MIN, "24h": 24 * 60 * MIN, "7d": 7 * 24 * 60 * MIN };
/** Chart bars: fifteen minutes for five hours, an hour for a day, six hours for a week. */
const STEP_MS: Record<TokenWindow, number> = { "5h": 15 * MIN, "24h": 60 * MIN, "7d": 6 * 60 * MIN };
const FEED_RESOURCE_ID = "claude-code-feed";
const KV_OPENCODE = "opencode:";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export default function modelUsagePlugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    corporateModels: {
      type: "string",
      label: "Corporate models",
      description:
        "OpenCode models to group and highlight as your organisation's own: provider/model prefixes separated by commas or new lines, for example `acme/` or `acme/coder-`. Empty: none.",
      experimental_multiline: true,
      default: "",
    },
    corporateLabel: {
      type: "string",
      label: "Corporate group name",
      description: "How the corporate models are titled in the panel. Empty: Corporate models.",
      default: "",
    },
    corporateOnly: {
      type: "boolean",
      label: "Corporate models only",
      description: "Show only the corporate models: no plan limits, no Claude Code, no other OpenCode providers.",
      default: false,
    },
  });

  const dataDir = path.dirname(bb.storage.database().name);
  const hostsList = async () =>
    (await bb.sdk.hosts.list())
      .filter((h) => h.type !== "ephemeral" && h.lifecycle?.phase !== "destroyed")
      .map((h) => ({ id: h.id, name: h.name, status: h.status }));
  let primaryHostId: string | null = null;
  const primary = async () => {
    primaryHostId ??= (await bb.sdk.system.config()).primaryHostId ?? null;
    return primaryHostId;
  };

  // ── Plan limits ────────────────────────────────────────────────────────────
  const limits = new LimitsCollector({
    selfId: bb.pluginId,
    discover: async () =>
      (await bb.sdk.plugins.experimental_discoverRpc({ method: usageListMethod })).map((m) => ({
        pluginId: m.pluginId,
        displayName: m.displayName,
      })),
    list: (pluginId) =>
      bb.sdk.plugins.callRpc({
        pluginId,
        method: usageListMethod,
        input: {},
        outputSchema: usageSourceRpcContract[usageListMethod].output,
        signal: AbortSignal.timeout(SOURCE_CALL_MS),
      }),
    fetch: (pluginId, resourceId, refresh) =>
      bb.sdk.plugins.callRpc({
        pluginId,
        method: usageFetchMethod,
        input: { resourceId, refresh },
        outputSchema: usageSourceRpcContract[usageFetchMethod].output,
        signal: AbortSignal.timeout(SOURCE_CALL_MS),
      }),
    hosts: hostsList,
    primaryHostId: primary,
    providers: async () =>
      (await bb.sdk.providers.list({ capability: "usage" })).map((p) => ({ id: p.id, displayName: p.displayName })),
    readFeed: () => readLimitsFeed(feedDirs(dataDir)),
    now: Date.now,
    log: { info: (m) => bb.log.info(m), warn: (m) => bb.log.warn(m) },
  });

  // ── OpenCode on every machine ──────────────────────────────────────────────
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const opencode = new OpencodeCollector({
    hosts: hostsList,
    read: (hostId, now) => host.call("readOpencode", { now }, { hostId, timeoutMs: HOST_CALL_MS }),
    load: (hostId) => bb.storage.kv.get<StoredReading>(KV_OPENCODE + hostId),
    save: (hostId, reading) => bb.storage.kv.set(KV_OPENCODE + hostId, reading),
    forget: (hostId) => bb.storage.kv.delete(KV_OPENCODE + hostId),
    storedHosts: async () => (await bb.storage.kv.list(KV_OPENCODE)).map((key) => key.slice(KV_OPENCODE.length)),
    now: Date.now,
    log: { warn: (m) => bb.log.warn(m) },
  });

  // ── Claude Code's session logs on this machine ─────────────────────────────
  const scanner = usageScannerForPlugin(bb);
  const summaries = new Map<TokenWindow, { at: number; value: UsageSummary }>();
  function summaryFor(window: TokenWindow): UsageSummary {
    const to = Date.now();
    const cached = summaries.get(window);
    if (cached && to - cached.at < SUMMARY_TTL_MS) return cached.value;
    const value = scanner.summary({ from: to - WINDOW_MS[window], to, topN: TOP_ROWS, timelineStepMs: STEP_MS[window] });
    summaries.set(window, { at: to, value });
    return value;
  }
  let claudeCache: { at: number; value: Record<TokenWindow, ClaudeModelTotals[]> } | null = null;
  function claudePerWindow(): Record<TokenWindow, ClaudeModelTotals[]> {
    const now = Date.now();
    if (claudeCache && now - claudeCache.at < CLAUDE_TTL_MS) return claudeCache.value;
    const out = {} as Record<TokenWindow, ClaudeModelTotals[]>;
    for (const window of ["5h", "24h", "7d"] as const) {
      const summary = scanner.summary({ from: now - WINDOW_MS[window], to: now, topN: 0, skipThreads: true });
      out[window] = summary.byModel.map((bucket) => ({
        model: bucket.key,
        calls: bucket.totals.calls,
        input: bucket.totals.input,
        output: bucket.totals.output,
        cacheCreation: bucket.totals.cacheCreation,
        cacheRead: bucket.totals.cacheRead,
      }));
    }
    claudeCache = { at: now, value: out };
    return out;
  }

  async function tokens(input: { maxAgeMs: number; force: boolean }): Promise<TokensSnapshot> {
    const current = await settings.get();
    const prefixes = parsePrefixes(current.corporateModels);
    const [machines, primaryId, hosts] = await Promise.all([
      opencode.get({ maxAgeMs: Math.max(input.maxAgeMs, OPENCODE_MIN_AGE_MS), force: input.force }),
      primary().catch(() => null),
      hostsList().catch(() => []),
    ]);
    const groups: ModelGroup[] = [];
    if (primaryId) {
      const group = claudeGroup({
        hostId: primaryId,
        hostName: hosts.find((h) => h.id === primaryId)?.name ?? "This server",
        perWindow: claudePerWindow(),
        collectedAt: Date.now(),
        prefixes,
      });
      if (group) groups.push(group);
    }
    for (const machine of machines) {
      groups.push(
        ...opencodeGroups({
          hostId: machine.hostId,
          hostName: machine.hostName,
          online: machine.online,
          rows: machine.reading?.rows ?? [],
          collectedAt: machine.reading?.collectedAt ?? null,
          problem: machine.problem,
          prefixes,
        }),
      );
    }
    const status = scanner.status();
    return {
      groups: arrangeGroups(groups, current.corporateOnly),
      corporateLabel: current.corporateLabel.trim(),
      corporateOnly: current.corporateOnly,
      claudeScanning: status.cold,
      updatedAt: Date.now(),
    };
  }

  bb.rpc.register(rpcContract, {
    limits: async ({ maxAgeMs, force }) => {
      if ((await settings.get()).corporateOnly) return { accounts: [], machines: [], updatedAt: Date.now() };
      return limits.get({ maxAgeMs, force });
    },
    tokens,
    activity: ({ window }) => summaryFor(window),
    scanStatus: () => scanner.status(),
  });

  // ── The limits file, offered to every usage panel ─────────────────────────
  // While Claude Code's own check fails, other panels (bb's Provider usage
  // included) get a row with the file's figures — unless Usage Meter, which
  // offers the same row, is still installed.
  async function serverHost(): Promise<{ id: string; name: string } | null> {
    const id = await primary();
    if (!id) return null;
    const found = await bb.sdk.hosts.get({ hostId: id });
    return { id: found.id, name: found.name };
  }
  bb.rpc.register(
    usageSourceRpcContract,
    {
      [usageListMethod]: async () => {
        if (!limits.feeding()) return { resources: [] };
        const others = await bb.sdk.plugins.experimental_discoverRpc({ method: usageListMethod }).catch(() => []);
        if (others.some((m) => m.pluginId === "usage-meter")) return { resources: [] };
        const server = await serverHost().catch(() => null);
        if (!server) return { resources: [] };
        return {
          resources: [
            {
              // Null on purpose: a key would make panels merge this row with the
              // provider's own, and keep whichever came first — the empty one.
              accountKey: null,
              id: FEED_RESOURCE_ID,
              providerId: CLAUDE_PROVIDER_ID,
              label: "Claude Code",
              scope: { kind: "host" as const, hostId: server.id, hostName: server.name },
            },
          ],
        };
      },
      [usageFetchMethod]: async ({ resourceId }) => {
        if (resourceId !== FEED_RESOURCE_ID) throw new Error(`Unknown resource: ${resourceId}`);
        const account = { plan: null, accountEmail: null, planLabel: null };
        const feed = await readLimitsFeed(feedDirs(dataDir));
        if (!feed) {
          return {
            accountKey: null,
            observedAt: null,
            usage: { status: "error" as const, ...account, message: `${FEED_FILE} is missing or stale.` },
          };
        }
        return {
          accountKey: null,
          observedAt: Date.parse(feed.fetchedAt),
          usage: {
            status: "ok" as const,
            ...account,
            windows: feed.windows.map((w, i) => ({
              kind: feedWindowKind(w.label) as "five-hour" | "weekly" | "custom",
              id: `feed-${i}`,
              label: w.label,
              usedPercent: w.usedPercent,
              resetsAt: w.resetsAt,
              model: null,
              cost: null,
            })),
          },
        };
      },
    },
    { experimental_discoverable: true },
  );

  // ── Background ─────────────────────────────────────────────────────────────
  bb.background.service("usage-scan", {
    start: (signal) => scanner.runForever(signal, SCAN_MS),
  });
  bb.background.service("limits", {
    async start(signal) {
      while (!signal.aborted) {
        if (!(await settings.get().catch(() => ({ corporateOnly: false }))).corporateOnly) {
          await limits.get({ maxAgeMs: LIMITS_POLL_MS - 10_000, force: false }).catch((error) => {
            bb.log.warn(`limits: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        await sleep(LIMITS_POLL_MS, signal);
      }
    },
  });
  bb.background.service("opencode", {
    async start(signal) {
      while (!signal.aborted) {
        await opencode.get({ maxAgeMs: OPENCODE_POLL_MS - 10_000, force: false }).catch((error) => {
          bb.log.warn(`opencode: ${error instanceof Error ? error.message : String(error)}`);
        });
        await sleep(OPENCODE_POLL_MS, signal);
      }
    },
  });
}
