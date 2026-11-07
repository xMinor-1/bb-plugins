// OpenCode figures from every machine bb reaches. Each machine reads its own
// database (host entry, reader.ts); the server keeps the last answer of each,
// so a laptop that went offline still shows what it spent, dated.
import type { OpencodeReadResult, OpencodeRow } from "./reader";

export interface StoredReading {
  hostName: string;
  /** When the machine answered, epoch ms; the buckets are relative to it. */
  collectedAt: number;
  rows: OpencodeRow[];
}

export interface MachineReading {
  hostId: string;
  hostName: string;
  online: boolean;
  reading: StoredReading | null;
  problem: "not_found" | "error" | "offline" | null;
}

export interface OpencodeCollectorDeps {
  hosts(): Promise<Array<{ id: string; name: string; status: "connected" | "disconnected" }>>;
  read(hostId: string, now: number): Promise<OpencodeReadResult>;
  load(hostId: string): Promise<StoredReading | undefined>;
  save(hostId: string, reading: StoredReading): Promise<void>;
  forget(hostId: string): Promise<void>;
  storedHosts(): Promise<string[]>;
  now(): number;
  log?: { warn(message: string): void };
}

/** An offline machine's last answer stops being shown after a week. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
const FORCE_GAP_MS = 10_000;

interface HostState {
  checkedAt: number;
  status: OpencodeReadResult["status"] | "unreachable";
}

export class OpencodeCollector {
  private states = new Map<string, HostState>();
  private running = new Map<string, Promise<void>>();

  constructor(private deps: OpencodeCollectorDeps) {}

  private async readHost(host: { id: string; name: string }): Promise<void> {
    const running = this.running.get(host.id);
    if (running) return running;
    const task = (async () => {
      const now = this.deps.now();
      try {
        const result = await this.deps.read(host.id, now);
        this.states.set(host.id, { checkedAt: now, status: result.status });
        if (result.status === "ok") {
          await this.deps.save(host.id, { hostName: host.name, collectedAt: now, rows: result.rows });
        } else if (result.status === "not_found") {
          await this.deps.forget(host.id);
        } else {
          this.deps.log?.warn(`opencode on ${host.name}: ${result.message}`);
        }
      } catch (error) {
        this.states.set(host.id, { checkedAt: now, status: "unreachable" });
        this.deps.log?.warn(`opencode on ${host.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => this.running.delete(host.id));
    this.running.set(host.id, task);
    return task;
  }

  /** Every machine with OpenCode figures, read anew when older than `maxAgeMs`. */
  async get(options: { maxAgeMs: number; force: boolean }): Promise<MachineReading[]> {
    const hosts = await this.deps.hosts();
    const now = this.deps.now();
    await Promise.all(
      hosts
        .filter((h) => h.status === "connected")
        .filter((h) => {
          const state = this.states.get(h.id);
          if (!state) return true;
          const age = now - state.checkedAt;
          return options.force ? age >= FORCE_GAP_MS : age >= options.maxAgeMs;
        })
        .map((h) => this.readHost(h)),
    );
    const known = new Map(hosts.map((h) => [h.id, h]));
    const ids = new Set([...hosts.map((h) => h.id), ...(await this.deps.storedHosts())]);
    const out: MachineReading[] = [];
    for (const hostId of ids) {
      const host = known.get(hostId);
      const reading = (await this.deps.load(hostId)) ?? null;
      if (reading && now - reading.collectedAt > KEEP_MS) {
        await this.deps.forget(hostId);
        continue;
      }
      const online = host?.status === "connected";
      const state = this.states.get(hostId);
      const problem: MachineReading["problem"] = !online
        ? "offline"
        : state?.status === "not_found"
          ? "not_found"
          : state?.status === "error" || state?.status === "unreachable"
            ? "error"
            : null;
      if (!reading && (problem === "not_found" || problem === "offline" || !state)) continue;
      out.push({ hostId, hostName: host?.name ?? reading?.hostName ?? hostId, online, reading, problem });
    }
    return out;
  }
}
