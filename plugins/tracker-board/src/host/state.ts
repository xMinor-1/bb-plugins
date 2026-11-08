// The host entry's persistent state: one JSON file in the plugin's data directory
// on this machine. No key here: it lives in the OS store.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lastCheckSchema } from "../../contract.js";

const stateSchema = z.object({
  /** The address the key was saved for: the key goes nowhere else. */
  origin: z.string().nullable().default(null),
  lastCheck: lastCheckSchema.nullable().default(null),
});
export type HostState = z.infer<typeof stateSchema>;

export class StateFile {
  #state: HostState | null = null;
  #writing: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(readonly dataDir: string) {
    this.path = join(dataDir, "state.json");
  }

  async load(): Promise<HostState> {
    if (this.#state) return this.#state;
    let raw: unknown = {};
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      raw = {};
    }
    const parsed = stateSchema.safeParse(raw);
    this.#state = parsed.success ? parsed.data : stateSchema.parse({});
    return this.#state;
  }

  async update(change: (state: HostState) => HostState): Promise<HostState> {
    const next = change(structuredClone(await this.load()));
    this.#state = next;
    const write = this.#writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
    });
    this.#writing = write.catch(() => {});
    await write;
    return next;
  }
}
