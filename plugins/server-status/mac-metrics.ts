import { execFileSync } from "node:child_process";
export type Usage = { percent: number; usedBytes: number; totalBytes: number };
function usage(usedBytes: number, totalBytes: number): Usage {
  if (
    !Number.isFinite(usedBytes) ||
    !Number.isFinite(totalBytes) ||
    !(totalBytes > 0) ||
    usedBytes < 0 ||
    usedBytes > totalBytes
  )
    throw new Error("Invalid memory counters");
  return {
    usedBytes,
    totalBytes,
    percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}
export function parseMacMemory(text: string, total: number): Usage {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) throw new Error("vm_stat: missing page size");
  const count = (name: string) => {
    const match = new RegExp("^" + name + ":\\s+(\\d+)", "m").exec(text);
    if (!match) throw new Error("vm_stat: missing " + name);
    return Number(match[1]);
  };
  // Resident anonymous pages exclude the file cache. Count the physical
  // compressor allocation, never its larger logical stored-page count.
  const pages =
    count("Anonymous pages") -
    count("Pages purgeable") +
    count("Pages wired down") +
    count("Pages occupied by compressor");
  return usage(pages * Number(page[1]), total);
}
export function parseMacSwap(text: string): Usage {
  const read = (name: string) => {
    const match = new RegExp(name + " = ([0-9.]+)([KMGTP])").exec(text);
    if (!match) throw new Error("sysctl vm.swapusage: missing " + name);
    return Number(match[1]) * 1024 ** ("KMGTP".indexOf(match[2]) + 1);
  };
  const total = read("total"),
    used = read("used");
  return total === 0 && used === 0
    ? { percent: 0, usedBytes: 0, totalBytes: 0 }
    : usage(used, total);
}
function command(path: string, args: string[]): string {
  return execFileSync(path, args, {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 65536,
    env: { ...process.env, LC_ALL: "C" },
  });
}
export function readMacMemory(total: number) {
  return parseMacMemory(command("/usr/bin/vm_stat", []), total);
}
export function readMacSwap() {
  return parseMacSwap(command("/usr/sbin/sysctl", ["-n", "vm.swapusage"]));
}
export function readMacPressure(): "normal" | "warning" | "critical" {
  const value = Number(
    command("/usr/sbin/sysctl", [
      "-n",
      "kern.memorystatus_vm_pressure_level",
    ]).trim(),
  );
  if (value === 1) return "normal";
  if (value === 2) return "warning";
  if (value === 4) return "critical";
  throw new Error("Unknown macOS memory pressure level: " + value);
}
