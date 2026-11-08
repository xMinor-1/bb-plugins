import type { FeedStorage } from "../src/feed";

export function memoryStorage(): FeedStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
  };
}
