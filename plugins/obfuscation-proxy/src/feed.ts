// Per-thread request feed: what left the machine, how, and what was masked.
// Kept in memory and saved to plugin storage when a request finishes.

import { isTokenCount, sumMasked, type FeedEntry, type ThreadTotals } from "./shared";

export interface FeedStorage {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface ThreadFeed {
  entries: FeedEntry[];
  totals: ThreadTotals;
}

export const FEED_LIMIT = 100;

function emptyTotals(): ThreadTotals {
  return { requests: 0, tokenCounts: 0, masked: 0, direct: 0, errors: 0, lastAt: null };
}

function isError(entry: FeedEntry): boolean {
  return entry.error !== null || (entry.status !== null && entry.status >= 400);
}

export class ThreadFeeds {
  private readonly feeds = new Map<string, Promise<ThreadFeed>>();
  private readonly saves = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleSave(threadId: string, feed: ThreadFeed): void {
    if (this.saves.has(threadId)) return;
    const timer = setTimeout(() => {
      this.saves.delete(threadId);
      void this.storage.set(this.key(threadId), feed).catch(() => {});
    }, 2_000);
    timer.unref?.();
    this.saves.set(threadId, timer);
  }

  constructor(
    private readonly storage: FeedStorage,
    private readonly limit = FEED_LIMIT,
  ) {}

  private key(threadId: string): string {
    return `feed:${threadId}`;
  }

  private load(threadId: string): Promise<ThreadFeed> {
    let feed = this.feeds.get(threadId);
    if (feed === undefined) {
      feed = this.storage.get<ThreadFeed>(this.key(threadId)).then(
        (saved) => (saved ? { entries: saved.entries, totals: { ...emptyTotals(), ...saved.totals } } : { entries: [], totals: emptyTotals() }),
        () => ({ entries: [], totals: emptyTotals() }),
      );
      this.feeds.set(threadId, feed);
    }
    return feed;
  }

  async entries(threadId: string, limit = this.limit): Promise<FeedEntry[]> {
    const feed = await this.load(threadId);
    return feed.entries.slice(0, limit);
  }

  async totals(threadId: string): Promise<ThreadTotals> {
    return { ...(await this.load(threadId)).totals };
  }

  /** Adds a request that just started; newest first. Token counts stay out of the list. */
  async start(threadId: string, entry: FeedEntry): Promise<void> {
    const feed = await this.load(threadId);
    if (isTokenCount(entry.path) && entry.via !== "blocked") return;
    feed.entries.unshift(entry);
    if (feed.entries.length > this.limit) feed.entries.length = this.limit;
  }

  /** Records the outcome of a started request and saves the feed. */
  async finish(threadId: string, entry: FeedEntry): Promise<void> {
    const feed = await this.load(threadId);
    entry.maskedTotal = sumMasked(entry.masked);
    if (isTokenCount(entry.path)) feed.totals.tokenCounts += 1;
    else feed.totals.requests += 1;
    // Token counts repeat the conversation text, so only model requests add to the masked total.
    if (!isTokenCount(entry.path)) feed.totals.masked += entry.maskedTotal;
    if (entry.via === "direct") feed.totals.direct += 1;
    if (isError(entry)) feed.totals.errors += 1;
    feed.totals.lastAt = entry.at;
    // A burst of token counts saves once at its end rather than per request.
    if (isTokenCount(entry.path) && !isError(entry)) {
      this.scheduleSave(threadId, feed);
      return;
    }
    await this.storage.set(this.key(threadId), feed);
  }
}

/**
 * Matches the proxy's per-request masking report to the request it belongs
 * to. The report carries the size of the body it read, so a pending request
 * with the same body size takes it, oldest first.
 */
export class MaskMatcher {
  private pending: { bytes: number; apply: (byCategory: Record<string, number>) => void }[] = [];

  expect(bytes: number, apply: (byCategory: Record<string, number>) => void): () => void {
    const item = { bytes, apply };
    this.pending.push(item);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== item);
    };
  }

  report(inBytes: number, byCategory: Record<string, number>): boolean {
    const index = this.pending.findIndex((item) => item.bytes === inBytes);
    if (index === -1) return false;
    const [item] = this.pending.splice(index, 1);
    item!.apply(byCategory);
    return true;
  }

  get size(): number {
    return this.pending.length;
  }
}
