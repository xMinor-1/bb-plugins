// lib/fm-store.ts — the panel's two-tier client store (PATHBAR-SPEC §1.2).
//
// Tier 1 is module scope: it survives a remount of the panel inside one page
// session and is written synchronously, so nothing is lost between an unmount
// and the remount the host performs when you navigate away and back.
// Tier 2 is `window.localStorage`: it survives a reload and a bb restart.
//
// The rules below are carried over verbatim from TREE-SPEC §6, where they were
// inlined in `hooks/useTree.ts` for the expanded-folder set. The location
// memory needs exactly the same behaviour, so the mechanism moved here instead
// of being written a second time:
//
//   * every storage access sits inside try/catch — a throw inside a slot
//     component disables the plugin's whole UI for the session (SPEC §8.1);
//   * a corrupt or foreign row degrades to the fallback, silently;
//   * the serialized payload is size-capped *before* the write, never after;
//   * the key is namespaced `bb-plugin-file-manager:<what>:v1`, so a shape
//     change is a new key rather than a migration.

export interface SessionStore<T> {
  /** Tier 1 if warm, else tier 2, else the fallback. Never throws. */
  read(): T;
  /** Tier 1 only — synchronous, for a remount inside one page session. */
  remember(value: T): void;
  /** Tier 1 + tier 2. Never throws; a denied storage degrades to tier 1. */
  write(value: T): void;
  /** Forget the value in both tiers and drop the storage row entirely. */
  clear(): void;
  /** Test seam: forget tier 1 so the next read goes to storage. */
  reset(): void;
}

export interface SessionStoreOptions<T> {
  key: string;
  /** Value to use when nothing readable is stored. */
  fallback: () => T;
  /** Parses the decoded JSON value; returns `null` to reject it. */
  parse: (raw: unknown) => T | null;
  /** Serialized payloads larger than this are dropped, never written. */
  maxBytes: number;
}

export function createSessionStore<T>(options: SessionStoreOptions<T>): SessionStore<T> {
  const { key, fallback, parse, maxBytes } = options;

  /** Tier 1. `null` means "cold": the next read goes to storage. */
  let cached: { value: T } | null = null;

  function readStorage(): T | null {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      const decoded: unknown = JSON.parse(raw);
      return parse(decoded);
    } catch {
      // Storage denied (an Electron partition can do this) or a corrupt row.
      return null;
    }
  }

  return {
    read(): T {
      if (cached !== null) return cached.value;
      const stored = readStorage();
      const settled = stored === null ? fallback() : stored;
      cached = { value: settled };
      return settled;
    },

    remember(value: T): void {
      cached = { value };
    },

    write(value: T): void {
      cached = { value };
      try {
        const json = JSON.stringify(value);
        if (json.length > maxBytes) return; // never blow the quota
        window.localStorage.setItem(key, json);
      } catch {
        /* tier 1 only */
      }
    },

    clear(): void {
      cached = { value: fallback() };
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* tier 1 only */
      }
    },

    reset(): void {
      cached = null;
    },
  };
}
