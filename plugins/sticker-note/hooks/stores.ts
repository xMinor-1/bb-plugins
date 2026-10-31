// Small module-level stores for state that several mounted pieces share: the
// board filter (title bar and page body) and Today's count (the navigation
// badge hook feeds it, the footer button's content script draws it).
import { useSyncExternalStore } from "react";

import type { TodayStats } from "../src/board";

export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

function createStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (equal(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export type Filter = "all" | "work" | "personal";
const FILTER_KEY = "sticker-note.filter";

function readFilter(): Filter {
  try {
    const saved = window.localStorage.getItem(FILTER_KEY);
    return saved === "work" || saved === "personal" ? saved : "all";
  } catch {
    return "all";
  }
}

export const filterStore = createStore<Filter>(readFilter());
filterStore.subscribe(() => {
  try {
    window.localStorage.setItem(FILTER_KEY, filterStore.get());
  } catch {
    // Private mode or a full quota: the filter just is not remembered.
  }
});

export const todayStore = createStore<TodayStats>(
  { count: 0, overdue: 0 },
  (a, b) => a.count === b.count && a.overdue === b.overdue,
);
