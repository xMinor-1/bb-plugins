// Prepared HTML pages, kept for the next open.
//
// Serving a page means reading the file (over the network when it lives on
// another machine), minting a preview lease for its folder and injecting the
// bridge. A page is keyed by its document and version: the URL names the
// version, so the bytes for one key never change. Each page embeds its
// folder's preview lease in the <base>, so it is served again only while that
// lease has a good while left; after that a fresh page gets a fresh lease and
// the relative images and links on it keep working.
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

export interface PreparedPage {
  body: Buffer;
  /** The same bytes gzip-compressed, for browsers that accept it. */
  gzipped: Buffer;
  contentType: string;
  /** When the folder's preview lease in the page's <base> runs out. */
  leaseUntilMs: number;
}

export interface HtmlPageCacheOptions {
  maxEntries: number;
  /** Pages bigger than this are prepared for each request and not kept. */
  maxBytes: number;
  /** A kept page is served while its lease has at least this long left. */
  minLeaseLeftMs: number;
  now?: () => number;
}

export class HtmlPageCache {
  readonly #pages = new Map<string, PreparedPage>();
  readonly #options: HtmlPageCacheOptions;
  readonly #now: () => number;

  constructor(options: HtmlPageCacheOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get(docId: string, version: string): PreparedPage | null {
    const key = `${docId}\u0000${version}`;
    const page = this.#pages.get(key);
    if (!page) return null;
    this.#pages.delete(key);
    if (page.leaseUntilMs - this.#now() < this.#options.minLeaseLeftMs) return null;
    // Most recently used last, so eviction walks from the front.
    this.#pages.set(key, page);
    return page;
  }

  put(docId: string, version: string, page: PreparedPage): void {
    if (page.body.length > this.#options.maxBytes) return;
    const key = `${docId}\u0000${version}`;
    this.#pages.delete(key);
    this.#pages.set(key, page);
    while (this.#pages.size > this.#options.maxEntries) {
      const oldest = this.#pages.keys().next().value;
      if (oldest === undefined) break;
      this.#pages.delete(oldest);
    }
  }

  clear(): void {
    this.#pages.clear();
  }
}

export async function preparePage(
  injected: { body: Buffer; contentType: string },
  leaseUntilMs: number,
): Promise<PreparedPage> {
  return { ...injected, gzipped: await gzipAsync(injected.body), leaseUntilMs };
}

/** Whether an Accept-Encoding header allows gzip (`gzip;q=0` refuses it). */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((entry) => {
    const [coding = "", ...parameters] = entry.trim().toLowerCase().split(";");
    if (coding.trim() !== "gzip" && coding.trim() !== "*") return false;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}
