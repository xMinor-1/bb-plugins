import { describe, expect, it } from "vitest";
import { guideAnswer, parseGuide } from "../src/shared/guide";

const GUIDE = ["# Start here", "Pick a report.", "", "# Sales report", "Sales notes.", "", "# Funnel report", "Funnel notes."].join("\n");

describe("parseGuide", () => {
  it("splits on top-level headings only", () => {
    const sections = parseGuide("# One\n## Inner\ntext\n# Two\nmore");
    expect(sections.map((section) => section.title)).toEqual(["One", "Two"]);
    expect(sections[0]!.body).toBe("# One\n## Inner\ntext");
  });

  it("keeps text before the first heading as an untitled first section", () => {
    const sections = parseGuide("intro\n\n# One\nbody");
    expect(sections.map((section) => section.title)).toEqual(["", "One"]);
    expect(sections[0]!.body).toBe("intro");
  });

  it("does not take a comment in a code block for a heading", () => {
    const sections = parseGuide("# One\n```\n# not a heading\n```\n# Two\nbody");
    expect(sections.map((section) => section.title)).toEqual(["One", "Two"]);
    expect(sections[0]!.body).toContain("# not a heading");
  });

  it("reads Windows line ends", () => {
    expect(parseGuide("# One\r\nbody\r\n# Two\r\nmore").map((section) => section.title)).toEqual(["One", "Two"]);
  });

  it("finds nothing in an empty setting", () => {
    expect(parseGuide("")).toEqual([]);
    expect(parseGuide(" \n \n")).toEqual([]);
  });
});

describe("guideAnswer", () => {
  it("returns the first section and lists the others", () => {
    const answer = guideAnswer(GUIDE, undefined);
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Pick a report.");
    expect(answer.text).toContain("- Sales report");
    expect(answer.text).toContain("- Funnel report");
    expect(answer.text).not.toContain("Sales notes.");
  });

  it("does not offer a list when there is one section", () => {
    expect(guideAnswer("# Only\nbody", undefined).text).toBe("# Only\nbody");
  });

  it("reads a section by its title or a part of it, in any case", () => {
    expect(guideAnswer(GUIDE, "Sales report").text).toBe("# Sales report\nSales notes.");
    expect(guideAnswer(GUIDE, "funnel").text).toBe("# Funnel report\nFunnel notes.");
    expect(guideAnswer("# Воронка по КА\nтекст", "воронка").text).toBe("# Воронка по КА\nтекст");
  });

  it("prefers the exact title over a part of a longer one", () => {
    const guide = "# Start\nx\n# Sales report extended\nlong\n# Sales report\nshort";
    expect(guideAnswer(guide, "sales report").text).toBe("# Sales report\nshort");
  });

  it("treats a blank section as no section", () => {
    expect(guideAnswer(GUIDE, "  ").text).toContain("Pick a report.");
  });

  it("names the sections when one is not found", () => {
    const answer = guideAnswer(GUIDE, "Margin");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no section "Margin"');
    expect(answer.text).toContain("- Sales report");
  });

  it("says so when no guide is configured", () => {
    expect(guideAnswer("", undefined)).toEqual({ text: "No Qlik guide is configured here.", isError: false });
  });
});
