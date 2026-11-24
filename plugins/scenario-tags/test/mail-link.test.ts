import { describe, expect, it } from "vitest";
import { mailLink } from "../src/app/own";
import { parseCatalog } from "../src/catalog";
import { CATALOG } from "./fixtures";

describe("mailLink", () => {
  it("does not throw when the cut falls inside an emoji", () => {
    const base = parseCatalog(JSON.stringify(CATALOG)).scenarios[0]!;
    // Pad so that character 1800 of the body is the second half of a surrogate pair at some offset.
    for (let pad = 0; pad < 4; pad++) {
      const scenario = { ...base, description: `${"x".repeat(pad)}${"😀".repeat(200)}`.slice(0, 300) };
      const link = mailLink("keeper@example.test", scenario, "y".repeat(1500));
      expect(link.startsWith("mailto:keeper%40example.test?")).toBe(true);
      expect(() => decodeURIComponent(link)).not.toThrow();
    }
  });
});
