// Geometry of drawings, shared by the page view, the HTML bridge, and the
// server's snapshot of an HTML page. The panel and the server use the
// TypeScript functions; pages served into the review frame and the headless
// browser get the same code as ES2019 text (DRAWING_JS), which the tests keep
// in step with the TypeScript.
import type { Stroke } from "./types.js";

/** Strokes are red so they stand out from the blue of comment highlights. */
export const DRAW_COLOR = "#e5484d";
/** Line width in CSS pixels on screen. */
export const DRAW_WIDTH = 3;
/** A new point is kept only this far (in CSS pixels) from the last one. */
export const DRAW_STEP = 2;

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function strokeBounds(strokes: readonly Stroke[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.points.length; i += 2) {
      const x = stroke.points[i]!;
      const y = stroke.points[i + 1]!;
      if (!bounds) bounds = { x0: x, y0: y, x1: x, y1: y };
      else {
        bounds.x0 = Math.min(bounds.x0, x);
        bounds.y0 = Math.min(bounds.y0, y);
        bounds.x1 = Math.max(bounds.x1, x);
        bounds.y1 = Math.max(bounds.y1, y);
      }
    }
  }
  return bounds;
}

/**
 * The SVG path of a stroke, scaled by `sx` and `sy`. An arrow is a straight
 * line from the first point to the last with a head `head` units long.
 */
export function strokePath(stroke: Stroke, sx: number, sy: number, head: number): string {
  const p = stroke.points;
  const n = p.length;
  if (n < 2) return "";
  const r = (value: number) => Math.round(value * 100) / 100;
  if (stroke.tool === "arrow") {
    const x0 = p[0]! * sx;
    const y0 = p[1]! * sy;
    const x1 = p[n - 2]! * sx;
    const y1 = p[n - 1]! * sy;
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const spread = Math.PI / 7;
    const lx = x1 - head * Math.cos(angle - spread);
    const ly = y1 - head * Math.sin(angle - spread);
    const rx = x1 - head * Math.cos(angle + spread);
    const ry = y1 - head * Math.sin(angle + spread);
    return `M${r(x0)} ${r(y0)}L${r(x1)} ${r(y1)}M${r(lx)} ${r(ly)}L${r(x1)} ${r(y1)}L${r(rx)} ${r(ry)}`;
  }
  let d = `M${r(p[0]! * sx)} ${r(p[1]! * sy)}`;
  // A dot (a tap) still shows as a short mark.
  if (n === 2) return `${d}l0.01 0`;
  for (let i = 2; i + 1 < n; i += 2) d += `L${r(p[i]! * sx)} ${r(p[i + 1]! * sy)}`;
  return d;
}

/**
 * `drawingPaths(strokes, sx, sy, head)` and `drawingBounds(strokes)` as
 * ES2019 function declarations, for pages and the headless browser.
 */
export const DRAWING_JS = String.raw`
  function drawingBounds(strokes) {
    var bounds = null;
    for (var s = 0; s < strokes.length; s += 1) {
      var p = strokes[s].points;
      for (var i = 0; i + 1 < p.length; i += 2) {
        if (!bounds) bounds = { x0: p[i], y0: p[i + 1], x1: p[i], y1: p[i + 1] };
        else {
          bounds.x0 = Math.min(bounds.x0, p[i]);
          bounds.y0 = Math.min(bounds.y0, p[i + 1]);
          bounds.x1 = Math.max(bounds.x1, p[i]);
          bounds.y1 = Math.max(bounds.y1, p[i + 1]);
        }
      }
    }
    return bounds;
  }
  function drawingPath(stroke, sx, sy, head) {
    var p = stroke.points;
    var n = p.length;
    if (n < 2) return "";
    var r = function (value) { return Math.round(value * 100) / 100; };
    if (stroke.tool === "arrow") {
      var x0 = p[0] * sx, y0 = p[1] * sy, x1 = p[n - 2] * sx, y1 = p[n - 1] * sy;
      var angle = Math.atan2(y1 - y0, x1 - x0);
      var spread = Math.PI / 7;
      var lx = x1 - head * Math.cos(angle - spread), ly = y1 - head * Math.sin(angle - spread);
      var rx = x1 - head * Math.cos(angle + spread), ry = y1 - head * Math.sin(angle + spread);
      return "M" + r(x0) + " " + r(y0) + "L" + r(x1) + " " + r(y1) + "M" + r(lx) + " " + r(ly) + "L" + r(x1) + " " + r(y1) + "L" + r(rx) + " " + r(ry);
    }
    var d = "M" + r(p[0] * sx) + " " + r(p[1] * sy);
    if (n === 2) return d + "l0.01 0";
    for (var i = 2; i + 1 < n; i += 2) d += "L" + r(p[i] * sx) + " " + r(p[i + 1] * sy);
    return d;
  }
  /** An SVG element with the strokes, in the given document. */
  function drawingSvg(doc, strokes, opacity) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("style", "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;");
    var g = doc.createElementNS(NS, "g");
    g.setAttribute("fill", "none");
    g.setAttribute("stroke", "${DRAW_COLOR}");
    g.setAttribute("stroke-width", "${DRAW_WIDTH}");
    g.setAttribute("stroke-linecap", "round");
    g.setAttribute("stroke-linejoin", "round");
    g.setAttribute("opacity", String(opacity));
    for (var s = 0; s < strokes.length; s += 1) {
      var path = doc.createElementNS(NS, "path");
      path.setAttribute("d", drawingPath(strokes[s], 1, 1, 14));
      g.appendChild(path);
    }
    svg.appendChild(g);
    return svg;
  }
`;
