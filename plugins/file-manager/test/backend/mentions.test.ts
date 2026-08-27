// §8.8 — the composer mention provider: "@" a file from the machine bb runs on.
//
// Two host contracts drive every case here. `search` is time-boxed and
// failure-isolated, so it must answer with a list or with nothing — never with
// a throw. `resolve` runs at send time and a throw BLOCKS the send, so even a
// file that was deleted after it was picked has to come back as prose.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginMentionSearchContext } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MENTION_PROVIDER_ID, MENTION_PROVIDER_LABEL, PLUGIN_ID } from "../../contract";
import {
  MAX_CONTEXT_BYTES,
  createFileMentionProvider,
  registerMentions,
  resolveFile,
  searchFiles,
} from "../../src/mentions";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

/** The host always supplies the whole context; only `query` varies here. */
function ask(query: string): PluginMentionSearchContext {
  return { trigger: "@", query, projectId: null, threadId: null };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-mention-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-mention-out-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("registration", () => {
  it("registers one provider with the shared id and label", () => {
    const host = createFakePluginHost({ pluginId: PLUGIN_ID });
    registerMentions(host.bb);

    const providers = host.harness.inspection.registrations.mentionProviders;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe(MENTION_PROVIDER_ID);
    expect(providers[0]?.label).toBe(MENTION_PROVIDER_LABEL);
  });

  it("claims the @ trigger only", () => {
    const host = createFakePluginHost({ pluginId: PLUGIN_ID });
    registerMentions(host.bb);

    expect(host.harness.inspection.registrations.mentionProviders[0]?.triggers).toEqual(["@"]);
    // The registration itself leaves it out — "@" is the host's default, and
    // spelling it here would be the plugin claiming a trigger it never chose.
    expect(createFileMentionProvider().triggers).toBeUndefined();
  });
});

describe("search", () => {
  it("matches file names case-insensitively, under the root", async () => {
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "Release-Notes.md"), "hi");

    const items = await searchFiles(ask("release"));

    expect(items).toEqual([
      {
        id: path.join(root, "docs", "Release-Notes.md"),
        title: "Release-Notes.md",
        subtitle: "~/docs/Release-Notes.md",
      },
    ]);
  });

  it("answers an empty query with no rows instead of walking the tree", async () => {
    await writeFile(path.join(root, "notes.txt"), "hi");

    expect(await searchFiles(ask(""))).toEqual([]);
    expect(await searchFiles(ask("   "))).toEqual([]);
  });

  it("offers files only — a folder has no content to attach", async () => {
    await mkdir(path.join(root, "reports"));
    await writeFile(path.join(root, "reports.txt"), "hi");

    const items = await searchFiles(ask("report"));

    expect(items.map((item) => item.title)).toEqual(["reports.txt"]);
  });

  it("skips dot-files and links that leave the root", async () => {
    await writeFile(path.join(root, ".secret-key.txt"), "hi");
    await writeFile(path.join(outside, "secret-elsewhere.txt"), "hi");
    await symlink(path.join(outside, "secret-elsewhere.txt"), path.join(root, "secret-link.txt"));

    expect(await searchFiles(ask("secret"))).toEqual([]);
  });

  it("follows a link that stays inside the root", async () => {
    await writeFile(path.join(root, "target-file.txt"), "hi");
    await symlink(path.join(root, "target-file.txt"), path.join(root, "alias-file.txt"));

    const items = await searchFiles(ask("alias"));

    expect(items.map((item) => item.title)).toEqual(["alias-file.txt"]);
  });

  it("stops at 20 rows", async () => {
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(root, `match-${String(index).padStart(2, "0")}.txt`), "hi");
    }

    expect(await searchFiles(ask("match-"))).toHaveLength(20);
  });

  it("answers with no rows instead of throwing when the root is unreadable", async () => {
    await rm(root, { recursive: true, force: true });

    await expect(searchFiles(ask("anything"))).resolves.toEqual([]);
  });
});

describe("resolve", () => {
  it("attaches the metadata and the content of a text file", async () => {
    const file = path.join(root, "notes.md");
    await writeFile(file, "# Title\n\nbody text\n");

    const { context } = await resolveFile(file);

    expect(context).toContain(`File: ${file}`);
    expect(context).toContain("Size: 19 bytes");
    expect(context).toMatch(/Modified: \d{4}-\d{2}-\d{2}T/u);
    expect(context).toContain("```md\n# Title\n\nbody text\n\n```");
    expect(context).not.toContain("Truncated");
  });

  it("fences longer than any backtick run inside the file", async () => {
    const file = path.join(root, "fenced.md");
    await writeFile(file, "```js\nconst a = 1;\n```\n");

    const { context } = await resolveFile(file);

    // Three backticks inside means the block itself has to open with four,
    // or the content would close the block early.
    expect(context).toContain("````md\n```js");
    expect(context.trimEnd().endsWith("````")).toBe(true);
  });

  it("truncates a large text file and says so", async () => {
    const file = path.join(root, "big.txt");
    const size = MAX_CONTEXT_BYTES + 1024;
    await writeFile(file, "a".repeat(size));

    const { context } = await resolveFile(file);

    expect(context).toContain(
      `[Truncated: the first ${String(MAX_CONTEXT_BYTES)} of ${String(size)} bytes are shown.]`,
    );
    expect(context.length).toBeLessThan(size);
  });

  it("attaches no content for a binary file", async () => {
    const file = path.join(root, "blob.bin");
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe]));

    const { context } = await resolveFile(file);

    expect(context).toContain(`File: ${file}`);
    expect(context).toContain("binary");
    expect(context).not.toContain("```");
  });

  it("names an empty file instead of attaching an empty block", async () => {
    const file = path.join(root, "empty.txt");
    await writeFile(file, "");

    const { context } = await resolveFile(file);

    expect(context).toContain("The file is empty.");
    expect(context).not.toContain("```");
  });

  it("describes a directory rather than refusing it", async () => {
    const directory = path.join(root, "docs");
    await mkdir(directory);

    const { context } = await resolveFile(directory);

    expect(context).toContain(`File: ${directory}`);
    expect(context).toContain("This is a directory");
  });

  it("reports a file that vanished instead of blocking the send", async () => {
    const file = path.join(root, "gone.txt");

    const { context } = await resolveFile(file);

    expect(context).toContain(`File: ${file}`);
    expect(context).toContain("could not be read");
    expect(context).toContain("not_found");
  });

  it("refuses a path outside the root, still without throwing", async () => {
    const file = path.join(outside, "elsewhere.txt");
    await writeFile(file, "hi");

    const { context } = await resolveFile(file);

    expect(context).toContain("could not be read");
    expect(context).toContain("path_escape");
    expect(context).not.toContain("hi\n```");
  });

  it("resolves the id the search handed out", async () => {
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "picked.txt"), "content here");

    const [item] = await searchFiles(ask("picked"));
    const { context } = await resolveFile(item!.id);

    expect(context).toContain("content here");
  });
});
