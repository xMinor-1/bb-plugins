import { describe, expect, it } from "vitest";
import { checkManifest } from "../src/manifest.js";
import { parseManifestLocation, parseManifestJson } from "../src/fetch-manifest.js";
import { clone, sampleManifest } from "./fixtures.js";

describe("manifest check", () => {
  it("accepts the sample with its warnings", () => {
    const result = checkManifest(sampleManifest());
    expect(result.errors).toEqual([]);
    expect(result.manifest?.name).toBe("Example build");
    expect(result.warnings).toEqual(["mcp.wiki: no address yet"]);
  });

  it("refuses a newer format with an update hint", () => {
    const manifest = { ...sampleManifest(), schema: 2 };
    const result = checkManifest(manifest);
    expect(result.manifest).toBeNull();
    expect(result.errors[0]).toContain("Update Fleet Kit");
  });

  it("is strict at the root and in plugins, free inside opencode and config", () => {
    const extraRoot = { ...sampleManifest(), surprise: true };
    expect(checkManifest(extraRoot).errors.join()).toContain("surprise");
    const extraPlugin = clone(sampleManifest());
    (extraPlugin.plugins as Record<string, unknown>[])[1]!.colour = "blue";
    expect(checkManifest(extraPlugin).manifest).toBeNull();
    const freeOpencode = clone(sampleManifest());
    (freeOpencode.opencode as Record<string, unknown>).share = "disabled";
    expect(checkManifest(freeOpencode).errors).toEqual([]);
  });

  it.each([
    ["fleet-kit missing", (m: Record<string, any>) => { m.plugins = m.plugins.filter((p: any) => p.id !== "fleet-kit"); }, "fleet-kit"],
    ["undeclared secret", (m: Record<string, any>) => { m.secrets = []; }, "{secret:gateway-key} is not declared"],
    ["provider outside the allowed list", (m: Record<string, any>) => { m.allowedProviders = ["other"]; }, "not in allowedProviders"],
    ["required without source", (m: Record<string, any>) => { m.plugins[1].source = null; }, "needs a source"],
    ["install older than minVersion", (m: Record<string, any>) => { m.install.bb = "0.47.0"; }, "install.bb"],
    ["removal of a listed plugin", (m: Record<string, any>) => { m.removePlugins = ["notes"]; }, "also listed"],
    ["duplicate plugin", (m: Record<string, any>) => { m.plugins.push(clone(m.plugins[1])); }, "listed twice"],
    ["plugin MCP without plugin", (m: Record<string, any>) => { m.mcp.push({ id: "q", title: "Q", type: "plugin", plugin: "nope", default: false }); }, "refers to a plugin"],
  ])("rejects %s", (_, edit, message) => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    edit(manifest);
    const result = checkManifest(manifest);
    expect(result.manifest).toBeNull();
    expect(result.errors.join("\n")).toContain(message);
  });

  it("accepts plugin sources with spaces in a semver range", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = "git:https://git.example.test/plugins.git@semver:notes/:>=1.0.0 <3.0.0";
    expect(checkManifest(manifest).errors).toEqual([]);
  });
});

describe("manifest location", () => {
  it("understands paths, file URLs and https", () => {
    expect(parseManifestLocation("/srv/build/manifest.json")).toMatchObject({ kind: "file", path: "/srv/build/manifest.json" });
    expect(parseManifestLocation("file:///srv/build/manifest.json")).toMatchObject({ kind: "file", path: "/srv/build/manifest.json" });
    expect(parseManifestLocation("~/build/manifest.json").kind).toBe("file");
    const https = parseManifestLocation("https://git.example.test/raw/manifest.json?ref=main");
    expect(https).toMatchObject({ kind: "https", display: "https://git.example.test/raw/manifest.json" });
  });

  it.each(["http://git.example.test/m.json", "https://user:pw@git.example.test/m.json", "relative/m.json", ""])("refuses %s", (value) => {
    expect(() => parseManifestLocation(value)).toThrow();
  });

  it("strips a byte order mark and reports bad JSON", () => {
    expect(parseManifestJson("﻿{\"a\":1}")).toEqual({ a: 1 });
    expect(() => parseManifestJson("{")).toThrow("not valid JSON");
  });
});
