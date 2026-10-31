// Names people understand: the template a server was made from, else what
// the server says about itself, else its id made readable.
import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../contract";
import { baseName, cleanText, firstSentence, readableId, serverInfoFrom, summaryOf, templateFor, titleOf } from "../src/host/names";

const item = (id: string, name: string, description: string | null = null): CatalogItem => ({ id, name, description, category: null });

describe("templateFor", () => {
  const catalog = [item("wiki", "Wiki"), item("gitlab", "GitLab"), item("ai_gitlab", "GitLab AI"), item("ai", "AI assistant"), item("okr-goals", "Goals")];

  it("finds the template whose id ends the server's name, the longest one first", () => {
    expect(baseName("corp_ai_gitlab_8ce17341")).toBe("corp_ai_gitlab");
    expect(templateFor("corp_ai_gitlab_8ce17341", catalog)?.name).toBe("GitLab AI");
    expect(templateFor("corp_gitlab_8ce17341", catalog)?.name).toBe("GitLab");
    expect(templateFor("corp_wiki_e959979e", catalog)?.name).toBe("Wiki");
    expect(templateFor("corp_ai_d1518e64", catalog)?.name).toBe("AI assistant");
    expect(templateFor("corp_okr_goals_00aa11bb", catalog)?.name).toBe("Goals");
    expect(templateFor("wiki", catalog)?.name).toBe("Wiki");
  });

  it("matches by the template's name when its id is not in the server's name", () => {
    expect(templateFor("corp_helpdesk_12ab34cd", [item("3f2a8c1e-9b7d", "Helpdesk")])?.id).toBe("3f2a8c1e-9b7d");
  });

  it("does not guess from a word in the middle, or from a short instance id", () => {
    expect(templateFor("corp_ai_tracker_8ce17341", catalog)).toBeNull();
    expect(templateFor("corp_wikipedia_8ce17341", catalog)).toBeNull();
    // "facade" is hex but has no digit: it is a word, not an instance id.
    expect(baseName("corp_facade")).toBe("corp_facade");
  });
});

describe("titles and summaries", () => {
  it("prefers the template, then the server's title, then its name, then the id", () => {
    const template = { id: "wiki", name: "Wiki", description: "Search the wiki. Read pages." };
    const info = { name: "wiki-mcp", title: "Company wiki", summary: "Answers about the wiki." };
    expect(titleOf("corp_wiki_ab12cd34", template, info)).toBe("Wiki");
    expect(titleOf("corp_wiki_ab12cd34", null, info)).toBe("Company wiki");
    expect(titleOf("corp_wiki_ab12cd34", null, { ...info, title: null })).toBe("wiki-mcp");
    expect(titleOf("corp_wiki_ab12cd34", null, null)).toBe("Corp wiki");
    expect(summaryOf(template, info)).toBe("Search the wiki.");
    expect(summaryOf(null, info)).toBe("Answers about the wiki.");
    expect(summaryOf(null, null)).toBeNull();
    expect(readableId("x")).toBe("X");
  });

  it("takes the first sentence of the first line, without Markdown markers", () => {
    expect(firstSentence("## GitLab tools\nMerge requests.")).toBe("GitLab tools");
    expect(firstSentence("\n\n- Opens tickets. Closes them.")).toBe("Opens tickets.");
    expect(firstSentence("Version 2.1 adds search")).toBe("Version 2.1 adds search");
    expect(firstSentence("   ")).toBeNull();
    expect(firstSentence(`${"long ".repeat(100)}end.`)?.length).toBeLessThanOrEqual(160);
  });

  it("keeps control, bidi and line-break characters out of what the page shows", () => {
    expect(cleanText("Wi\u0000ki\u202e\u2028 search\r\n", 80)).toBe("Wi ki search");
    expect(cleanText(42, 80)).toBeNull();
    expect(cleanText("x".repeat(200), 80)).toHaveLength(80);
  });

  it("reads serverInfo and instructions from an initialize answer", () => {
    expect(serverInfoFrom({ serverInfo: { name: "desk", title: "Helpdesk" }, instructions: "Open tickets here. More text." })).toEqual({ name: "desk", title: "Helpdesk", summary: "Open tickets here." });
    expect(serverInfoFrom({ serverInfo: "nonsense" })).toBeNull();
    expect(serverInfoFrom({})).toBeNull();
  });

  it("stays fast on hostile text from a server or catalog", () => {
    const started = performance.now();
    const hostile = ["_".repeat(200_000), "a".repeat(2_000_000), `${"#".repeat(500_000)}x`, `${" ".repeat(1_000_000)}.`, "f".repeat(100_000) + "1"];
    for (const text of hostile) {
      firstSentence(text);
      cleanText(text, 80);
      templateFor(text, [item(text.slice(0, 200), text.slice(0, 200))]);
      serverInfoFrom({ serverInfo: { name: text, title: text }, instructions: text });
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
