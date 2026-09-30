import { describe, expect, it } from "vitest";
import { buildHandoffMessage } from "./message";
import type { Anchor, ReviewComment } from "./types";

function comment(id: string, anchor: Anchor, body: string): ReviewComment {
  return {
    id,
    seq: 1,
    status: "draft",
    anchor,
    body,
    docVersion: null,
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    sentThreadId: null,
    agentNote: null,
    resolvedAt: null,
  };
}

describe("drawings in the hand-off message", () => {
  it("names what each stroke of an HTML drawing touches", () => {
    const drawing = comment(
      "c_draw",
      {
        kind: "html-drawing",
        strokes: [
          { tool: "pen", points: [0, 0, 50, 0] },
          { tool: "arrow", points: [0, 0, 100, 100] },
          { tool: "pen", points: [0, 0, 10, 10, 0, 20, 0, 0] },
          { tool: "pen", points: [300, 300, 310, 300] },
        ],
        viewport: { w: 1200, h: 800 },
        marks: [
          { stroke: 0, role: "over", selector: "#save", tag: "button", text: "Save" },
          { stroke: 1, role: "from", selector: "#save", tag: "button", text: "Save" },
          { stroke: 1, role: "to", selector: "header", tag: "header", text: "" },
          { stroke: 2, role: "around", selector: "p", tag: "p", text: "Hello", frame: "iframe:nth-of-type(2)" },
        ],
      },
      "Move it up",
    );
    const text = buildHandoffMessage({
      kind: "html",
      absPath: "/site/index.html",
      comments: [drawing],
      imageNumbers: new Map([["c_draw", 1]]),
      imagePaths: new Map(),
    });
    expect(text).toContain("[c_draw] Drawing · image 1 attached\n");
    expect(text).toContain("Stroke 1: a line over <button> «Save» `#save`\n");
    expect(text).toContain("Stroke 2: an arrow from <button> «Save» `#save` to <header> `header`\n");
    expect(text).toContain("Stroke 3: a loop around <p> «Hello» `p` in frame `iframe:nth-of-type(2)`\n");
    expect(text).toContain("Stroke 4: a line on an empty spot\nMove it up");
    expect(text).toContain("A drawing is red strokes");
    expect(text).toContain('A comment "in frame"');
  });

  it("quotes the text under a drawing on a page", () => {
    const text = buildHandoffMessage({
      kind: "presentation",
      absPath: "/deck.pptx",
      comments: [
        comment("c_page", { kind: "page-drawing", page: 3, strokes: [{ tool: "pen", points: [0.1, 0.1, 0.2, 0.1] }], text: "Q3 revenue" }, "Remove"),
      ],
      imageNumbers: new Map(),
      imagePaths: new Map([["c_page", "/data/crops/c_page.png"]]),
    });
    expect(text).toContain("[c_page] Slide 3, drawing · image: `/data/crops/c_page.png` · text under the drawing: «Q3 revenue»");
  });
});
