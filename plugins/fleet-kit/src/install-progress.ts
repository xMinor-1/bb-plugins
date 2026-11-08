// What a sync installs, one plugin at a time, for the First run page: the
// plugin being installed now, the ones waiting, the ones done, and how long
// one install has taken so far. A first sync installs for many minutes, and a
// page with a spinner on every plugin tells the person nothing.
import type { InstallProgress } from "../contract.js";
import type { Manifest } from "./manifest.js";

type Item = InstallProgress["queue"][number];

/** The name the page shows for a plugin: its own title, else its branch or setup step title, else the id. */
export function pluginTitle(manifest: Manifest, id: string): string {
  const entry = manifest.plugins.find((plugin) => plugin.id === id);
  return (
    entry?.title ??
    manifest.branches?.optional.find((plugin) => plugin.id === id)?.title ??
    manifest.onboarding?.find((step) => step.plugin === id)?.title ??
    id
  );
}

export class InstallTracker {
  readonly #progress: InstallProgress;
  readonly #now: () => number;
  #currentAt = 0;
  #spent = 0;

  /** `ids`: the plugins this sync installs, in the order it installs them. */
  constructor(
    manifest: Manifest,
    ids: string[],
    private readonly onChange: (progress: InstallProgress) => void,
    now: () => number = Date.now,
  ) {
    this.#now = now;
    const item = (id: string): Item => ({ id, title: pluginTitle(manifest, id), note: manifest.plugins.find((plugin) => plugin.id === id)?.installNote ?? null });
    this.#progress = { startedAt: this.#iso(), finishedAt: null, current: null, queue: ids.map(item), done: [], averageSeconds: null };
    this.#emit();
  }

  /** Whether this sync installs the plugin (it was not installed when the sync started). */
  has(id: string): boolean {
    return this.#progress.queue.some((item) => item.id === id);
  }

  start(id: string): void {
    const index = this.#progress.queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.#progress.queue.splice(index, 1);
    this.#currentAt = this.#now();
    this.#progress.current = { ...item!, startedAt: this.#iso() };
    this.#emit();
  }

  finish(id: string, ok: boolean): void {
    const current = this.#progress.current;
    if (current === null || current.id !== id) return;
    const { startedAt: _, ...item } = current;
    this.#progress.done.push({ ...item, ok });
    this.#spent += Math.max(0, this.#now() - this.#currentAt) / 1000;
    this.#progress.averageSeconds = Math.round(this.#spent / this.#progress.done.length);
    this.#progress.current = null;
    this.#emit();
  }

  /** The sync is past its plugins; anything still queued was not reached (an error, or the sync stopped). */
  close(): void {
    if (this.#progress.finishedAt !== null) return;
    this.#progress.current = null;
    this.#progress.queue = [];
    this.#progress.finishedAt = this.#iso();
    this.#emit();
  }

  snapshot(): InstallProgress {
    return structuredClone(this.#progress);
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #emit(): void {
    try {
      this.onChange(this.snapshot());
    } catch {
      // The page learns on the next change; the install goes on.
    }
  }
}
