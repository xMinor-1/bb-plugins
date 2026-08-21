// bb-plugin-server-status — backend: host metrics for the sidebar footer icon
// (the ring around it) and for the details panel.
//
// One background service polls the host every 5 seconds and keeps a fresh
// snapshot in memory. The snapshot leaves by one path only — the `state` rpc:
// the frontend content script has no React hooks, and therefore no
// `useRealtime`, so it polls instead of subscribing. Publishing that same
// snapshot to the realtime channel as well would be pointless: it has no
// subscribers, and frames would reach tabs that are hidden and not polling.
//
// Everything is read straight from Node: /proc for CPU and memory, statfs for
// the disk. No dependencies, no shelling out.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { z } from "zod";

const TICK_MS = 5_000;
// The disk barely changes, and statfs is the most expensive read here, so it
// is polled twelve times less often than CPU and memory.
const DISK_TTL_MS = 60_000;
// The first CPU figure needs two samples; this is the window between them.
// Short enough for the indicator to fill before the first look at it.
const WARMUP_MS = 300;

// --- reading metrics --------------------------------------------------------

type CpuSample = { total: number; idle: number };

// The first line of /proc/stat is the sum over all cores, in ticks:
// user nice system idle iowait irq softirq steal guest guest_nice.
// Load is the delta between two samples; a single read says nothing.
function readCpuSample(): CpuSample | null {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const first = stat.slice(0, stat.indexOf("\n"));
    if (!first.startsWith("cpu ")) return null;
    const fields = first.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
    const total = fields.reduce((sum, n) => sum + n, 0);
    // iowait counts as idle: the CPU is waiting, not working.
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    return { total, idle };
  } catch {
    return null;
  }
}

function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const busy = total - (next.idle - prev.idle);
  return round1(clampPercent((busy / total) * 100));
}

// /proc/meminfo values are in kB (kibibytes in fact, despite the label).
function readMeminfo(): Map<string, number> {
  const values = new Map<string, number>();
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = /^(\w+):\s+(\d+)/.exec(line);
      if (match) values.set(match[1]!, Number(match[2]) * 1024);
    }
  } catch {
    /* not Linux, or procfs is not mounted — the caller falls back to os */
  }
  return values;
}

type Usage = { percent: number; usedBytes: number; totalBytes: number };

// MemAvailable is the kernel's own estimate of what a new process would get,
// which is what a person means by "used". MemFree alone counts every
// page-cache page as used and reports 95% on an idle machine.
function readMemory(): Usage {
  const info = readMeminfo();
  const total = info.get("MemTotal") ?? os.totalmem();
  const available = info.get("MemAvailable") ?? os.freemem();
  if (!(total > 0)) return { percent: 0, usedBytes: 0, totalBytes: 0 };
  const used = Math.max(0, total - available);
  return { percent: round1((used / total) * 100), usedBytes: used, totalBytes: total };
}

function readSwap(): Usage | null {
  const info = readMeminfo();
  const total = info.get("SwapTotal") ?? 0;
  if (!(total > 0)) return null;
  const used = Math.max(0, total - (info.get("SwapFree") ?? 0));
  return { percent: round1((used / total) * 100), usedBytes: used, totalBytes: total };
}

type DiskUsage = Usage & { availBytes: number; path: string };

// Arithmetic as in df(1): root-reserved blocks (bfree - bavail) are neither
// used nor available, so the percentage is used / (used + available).
// Dividing by the raw total understates the result by several points.
function readDisk(path: string): DiskUsage | null {
  try {
    const fs = statfsSync(path);
    const block = Number(fs.bsize);
    const total = Number(fs.blocks) * block;
    const free = Number(fs.bfree) * block;
    const avail = Number(fs.bavail) * block;
    const used = Math.max(0, total - free);
    const base = used + avail;
    if (!(total > 0) || !(base > 0)) return null;
    return {
      percent: clampPercent(Math.ceil((used / base) * 100)),
      usedBytes: used,
      totalBytes: total,
      availBytes: avail,
      path,
    };
  } catch {
    return null;
  }
}

// PRETTY_NAME is what a person calls the machine ("Ubuntu 24.04.4 LTS"). The
// file does not change while the server runs, so it is read once at startup.
function readOsName(): string {
  try {
    const match = /^PRETTY_NAME="?(.+?)"?$/m.exec(
      readFileSync("/etc/os-release", "utf8"),
    );
    if (match?.[1]) return match[1];
  } catch {
    /* not Linux, or the file is missing — fall back to what node knows */
  }
  return `${os.type()} ${os.release()}`;
}

// --- shared helpers ---------------------------------------------------------

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const round1 = (value: number): number => Math.round(value * 10) / 10;

// Ends early when the plugin stops: a plain setTimeout would sleep through the
// stop window and the plugin would report "degraded".
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// --- contract ---------------------------------------------------------------

const usageSchema = z.object({
  percent: z.number(),
  usedBytes: z.number(),
  totalBytes: z.number(),
});

const snapshotSchema = z.object({
  // null until the second CPU sample arrives, and where /proc/stat is absent.
  cpu: z.number().nullable(),
  cores: z.number(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: usageSchema,
  swap: usageSchema.nullable(),
  disk: usageSchema.extend({ availBytes: z.number(), path: z.string() }).nullable(),
  uptimeSeconds: z.number(),
  // Kernel version and human OS name are static, but the panel shows them.
  kernel: z.string(),
  osName: z.string(),
  // The frontend grows uptime from this moment without asking the server again.
  bootTimeMs: z.number(),
  updatedAt: z.number(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: snapshotSchema },
});

// --- plugin -----------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    diskPath: {
      type: "string",
      label: "Disk mount point",
      default: "/",
    },
  });

  let diskPath = (await settings.get()).diskPath.trim() || "/";
  let diskCache: { at: number; value: DiskUsage | null } | null = null;
  let latest: Snapshot | null = null;

  settings.onChange((next) => {
    diskPath = next.diskPath.trim() || "/";
    diskCache = null; // the next tick measures the new mount point
  });

  // os.cpus() walks every core, so the core count is taken once.
  const cores = os.cpus().length;
  const osName = readOsName();

  function disk(): DiskUsage | null {
    const now = Date.now();
    if (!diskCache || now - diskCache.at >= DISK_TTL_MS) {
      diskCache = { at: now, value: readDisk(diskPath) };
    }
    return diskCache.value;
  }

  function snapshot(cpu: number | null): Snapshot {
    const uptimeSeconds = Math.floor(os.uptime());
    const now = Date.now();
    const [one = 0, five = 0, fifteen = 0] = os.loadavg();
    return {
      cpu,
      cores,
      // Load average is context for the panel, not CPU load:
      // on this host /proc/stat showed 11.7% while loadavg1 said 8.09.
      load: [round1(one), round1(five), round1(fifteen)],
      memory: readMemory(),
      swap: readSwap(),
      disk: disk(),
      uptimeSeconds,
      kernel: os.release(),
      osName,
      bootTimeMs: now - uptimeSeconds * 1000,
      updatedAt: now,
    };
  }

  bb.rpc.register(rpcContract, {
    // Serves the service's snapshot; the fallback only fires in the first
    // fractions of a second after startup, before the service's first tick.
    state: () => latest ?? snapshot(null),
  });

  // One service per server, not per client: every panel reads the same
  // snapshot, so polling cost does not grow with the number of tabs.
  bb.background.service("metrics", {
    async start(signal) {
      let previous = readCpuSample();
      await sleep(WARMUP_MS, signal);
      while (!signal.aborted) {
        const current = readCpuSample();
        const cpu = previous && current ? cpuPercent(previous, current) : null;
        if (current) previous = current;
        latest = snapshot(cpu);
        await sleep(TICK_MS, signal);
      }
    },
  });

  bb.log.info(`watching ${cores} cores, disk ${diskPath}, tick ${TICK_MS}ms`);
}
