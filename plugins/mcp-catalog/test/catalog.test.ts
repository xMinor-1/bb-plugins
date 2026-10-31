// The catalog: shapes it accepts and how it is read; the page's link to the platform.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CatalogError, fetchCatalog, normalizeCatalog } from "../src/host/catalog";
import { platformLink } from "../src/app/McpPage";

describe("normalizeCatalog", () => {
  it("takes a list at the root or under a common key", () => {
    const list = [{ id: "wiki", name: "Wiki", description: "Company wiki search" }, { id: 7, title: "Tracker", tags: ["work"] }];
    for (const body of [list, { items: list }, { templates: list }, { data: { items: list } }]) {
      expect(normalizeCatalog(body)).toEqual([
        { id: "wiki", name: "Wiki", description: "Company wiki search", category: null },
        { id: "7", name: "Tracker", description: null, category: "work" },
      ]);
    }
  });

  it("drops entries without an id or name, duplicates and control characters", () => {
    expect(normalizeCatalog([{}, { id: "a", name: "A\u0007" }, { id: "a", name: "again" }])).toEqual([{ id: "a", name: "A", description: null, category: null }]);
    expect(() => normalizeCatalog({ nothing: true })).toThrow(CatalogError);
  });
});

describe("fetchCatalog", () => {
  it("reads JSON and reports what went wrong in a coded message", async () => {
    let reply: { status: number; body: string } = { status: 200, body: JSON.stringify([{ id: "x", name: "X" }]) };
    const server = createServer((_request, response) => {
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server-templates`;
    try {
      expect(await fetchCatalog(url)).toEqual([{ id: "x", name: "X", description: null, category: null }]);
      reply = { status: 503, body: "" };
      await expect(fetchCatalog(url)).rejects.toThrow(/^\[mcp:catalog-unreachable\] .*503/);
      reply = { status: 200, body: "<html>" };
      await expect(fetchCatalog(url)).rejects.toThrow(/^\[mcp:catalog-format\]/);
    } finally {
      server.close();
    }
    await expect(fetchCatalog("not a url")).rejects.toThrow(/^\[mcp:catalog-address\]/);
  });
});

describe("the page's platform link", () => {
  it("links only to a web address", () => {
    expect(platformLink(" https://mcp.example.com/dashboard ")).toBe("https://mcp.example.com/dashboard");
    expect(platformLink("javascript:alert(1)")).toBeNull();
    expect(platformLink("")).toBeNull();
  });
});
