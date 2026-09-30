import { describe, expect, it } from "vitest";
import { DRAWING_JS, strokeBounds, strokePath } from "./drawing";
import type { Stroke } from "./types";

const pen: Stroke = { tool: "pen", points: [10, 20, 30, 25, 50, 60] };
const arrow: Stroke = { tool: "arrow", points: [0, 0, 100, 0] };
const dot: Stroke = { tool: "pen", points: [5, 5] };

const js = new Function(`${DRAWING_JS}; return { drawingBounds, drawingPath };`)() as {
  drawingBounds: (strokes: Stroke[]) => unknown;
  drawingPath: (stroke: Stroke, sx: number, sy: number, head: number) => string;
};

describe("drawing geometry", () => {
  it("bounds every point of every stroke", () => {
    expect(strokeBounds([pen, arrow])).toEqual({ x0: 0, y0: 0, x1: 100, y1: 60 });
    expect(strokeBounds([])).toBeNull();
  });

  it("draws a pen stroke as a polyline, scaled", () => {
    expect(strokePath(pen, 2, 1, 10)).toBe("M20 20L60 25L100 60");
  });

  it("gives an arrow a head at its last point", () => {
    const d = strokePath(arrow, 1, 1, 10);
    expect(d).toBe("M0 0L100 0M90.99 4.34L100 0L90.99 -4.34");
  });

  it("keeps a tap visible", () => {
    expect(strokePath(dot, 1, 1, 10)).toBe("M5 5l0.01 0");
  });

  it("matches the copy that runs in pages", () => {
    for (const stroke of [pen, arrow, dot]) {
      expect(js.drawingPath(stroke, 1.5, 0.5, 12)).toBe(strokePath(stroke, 1.5, 0.5, 12));
    }
    expect(js.drawingBounds([pen, arrow])).toEqual(strokeBounds([pen, arrow]));
  });
});
