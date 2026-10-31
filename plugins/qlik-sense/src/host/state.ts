// The host entry's persistent state: one JSON file in the plugin's data
// directory on this machine. It survives worker restarts, which is what makes
// the "do not sign in again after a refusal" rule hold across agent sessions.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { catalogSchema, passwordStoreKindSchema, type Catalog } from "../../contract.js";

const stateSchema = z.object({
  url: z.string().nullable().default(null),
  user: z.string().nullable().default(null),
  passwordStore: passwordStoreKindSchema.nullable().default(null),
  passwordWarning: z.string().nullable().default(null),
  blocked: z.string().nullable().default(null),
  lastCheck: z.object({ ok: z.boolean(), at: z.number(), message: z.string() }).nullable().default(null),
  /** One engine identity per machine, so the agent never shares selections with a person's browser tab. */
  identity: z.string().default(() => `bb-agent-${randomBytes(4).toString("hex")}`),
  catalog: catalogSchema.default({ apps: [] }),
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

  /** Cached copy for synchronous reads (the sign-in guard). Call load() first. */
  current(): HostState {
    if (!this.#state) throw new Error("state not loaded");
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

  async setCatalog(catalog: Catalog): Promise<HostState> {
    return this.update((state) => ({ ...state, catalog }));
  }
}
