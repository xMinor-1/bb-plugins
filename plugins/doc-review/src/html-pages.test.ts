import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { acceptsGzip, HtmlPageCache, preparePage } from "./html-pages";

const MINUTE = 60 * 1000;

function page(text: string, leaseUntilMs: number) {
  return preparePage({ body: Buffer.from(text), contentType: "text/html" }, leaseUntilMs);
}

describe("prepared HTML pages", () => {
  it("are served again for the same document and version", async () => {
    let now = 0;
    const cache = new HtmlPageCache({ maxEntries: 2, maxBytes: 1024, minLeaseLeftMs: 30 * MINUTE, now: () => now });
    const prepared = await page("<p>v1</p>", 60 * MINUTE);
    cache.put("d_1", "v1", prepared);
    expect(cache.get("d_1", "v1")).toBe(prepared);
    expect(cache.get("d_1", "v2")).toBeNull();
    expect(gunzipSync(prepared.gzipped).toString()).toBe("<p>v1</p>");
    now = 20 * MINUTE;
    expect(cache.get("d_1", "v1")).toBe(prepared);
  });

  it("are dropped once their folder lease has less than the minimum left", async () => {
    let now = 0;
    const cache = new HtmlPageCache({ maxEntries: 2, maxBytes: 1024, minLeaseLeftMs: 30 * MINUTE, now: () => now });
    cache.put("d_1", "v1", await page("<p>v1</p>", 60 * MINUTE));
    now = 31 * MINUTE;
    expect(cache.get("d_1", "v1")).toBeNull();
    now = 0;
    expect(cache.get("d_1", "v1")).toBeNull();
  });

  it("keep only the most recently used, and never a page over the size limit", async () => {
    const cache = new HtmlPageCache({ maxEntries: 2, maxBytes: 16, minLeaseLeftMs: 0, now: () => 0 });
    cache.put("a", "1", await page("a", 60 * MINUTE));
    cache.put("b", "1", await page("b", 60 * MINUTE));
    expect(cache.get("a", "1")).not.toBeNull();
    cache.put("c", "1", await page("c", 60 * MINUTE));
    expect(cache.get("b", "1")).toBeNull();
    expect(cache.get("a", "1")).not.toBeNull();
    cache.put("big", "1", await page("x".repeat(17), 60 * MINUTE));
    expect(cache.get("big", "1")).toBeNull();
  });
});

describe("Accept-Encoding", () => {
  it("allows gzip unless the browser refuses it", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, gzip;q=0.8")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("br")).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });
});
