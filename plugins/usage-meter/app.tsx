// bb-plugin-usage-meter — two rings of Claude limit usage in the sidebar footer.
//
//   outer ring — the five-hour session, the "Current session" window
//   inner ring — the weekly limit, the "Weekly limit" window: smaller radius,
//                thinner stroke, a visible gap between the two
//   hover      — a popup with every window, the plan and the account email
//   click      — the same popup, pinned (for touch devices)
//
// Each ring colours by its own value: muted below 60%, amber from 60%, red
// above 85%. The per-model limit (Fable) gets no ring — a third ring stops
// being readable on a 32×32 button, so it lives as a row in the popup and
// takes a dot in the top right corner of the button as soon as it passes the
// amber threshold: otherwise an exhausted window gives away nothing.
//
// A one-off polling failure does not erase the figures: the backend keeps the
// previous windows, the rings go on showing them, and a separate popup row
// gives their age and the cause. Rings stay empty only with no snapshot at all.
//
// The host renders sidebarFooterAction as an icon only, so the rings come from
// a content script: its own <svg> goes inside the host button over the icon,
// and the popup is plain DOM above the application. The host icon stays where
// it is: the added node is absolutely positioned and takes no pointer events.
//
// The outer ring repeats the geometry of the neighbouring server-status plugin:
// the same path along the button edge, the same thickness, the same animation.
// These buttons sit side by side in the footer and must read as one system.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { UsageState } from "./server";
import {
  DANGER,
  PANEL_PATH,
  PLUGIN_ID,
  SESSION_LABEL,
  SHORT_LABEL,
  WARN,
  WEEKLY_LABEL,
  extraMax,
  findWindow,
  hasFigures,
  labelKey,
  percentOf,
  resetText,
  ringOf,
  staleLine,
  statusLine,
  type Line,
} from "./lib/limits";
import { openUsagePanel, usagePanelHref } from "./lib/panel-link";
import { UsageAccessory } from "./components/UsageAccessory";
import { UsagePage } from "./components/UsagePage";

const ACTION_ID = "usage";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;

// A bridge between the host's `run` and the content script: they live in
// different modules of one window, so keyboard activation reaches the popup as an event.
const TOGGLE_EVENT = "usage-meter:toggle";

/** Own snapshot poll. The data is shared, so polling faster than the backend is pointless. */
const POLL_MS = 60_000;
/** Floor between polls: protection against frequent visibilitychange. */
const MIN_GAP_MS = 10_000;
/** Delay before the hover popup — a cursor merely passing the button does not open it. */
const HOVER_MS = 250;
/** Grace period for moving the cursor from the button into the popup. */
const CLOSE_GRACE_MS = 250;

// --- ring geometry ----------------------------------------------------------

/** Outer ring thickness. Exactly the same in server-status — never change one alone. */
const OUTER_STROKE = 2;
/** The inner one is thinner: the pair must read as "main and qualifier". */
const INNER_STROKE = 1.5;
/** Clear gap between the ring strokes, in button pixels. */
const RING_GAP = 2;
/**
 * Inset of a ring centre line from the button edge. The outer one hugs the
 * edge as in server-status; the inner one is moved in by its own thickness
 * plus the gap, so on a 32×32 button its stroke runs 4…5.5 px from the edge
 * and never reaches the host icon (which owns the middle 16×16, from 8 px).
 */
const OUTER_INSET = OUTER_STROKE / 2;
const INNER_INSET = OUTER_STROKE + RING_GAP + INNER_STROKE / 2;

// --- data -------------------------------------------------------------------

async function fetchState(signal: AbortSignal): Promise<UsageState> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  const envelope = await response.json();
  if (!envelope?.ok) {
    throw new Error(envelope?.error?.message ?? "rpc failed");
  }
  return envelope.result as UsageState;
}

/**
 * Ring colour from its own value; null means there is no value. Lives here and
 * not in lib/limits.ts because it speaks in CSS variables with fallbacks: this
 * is an SVG attribute in a content script, not a Tailwind class.
 */
function ringColor(percent: number | null): string {
  if (percent === null) return "var(--muted-foreground, #8a8a8a)";
  if (percent > DANGER) return "var(--destructive, #e5484d)";
  if (percent >= WARN) return "var(--warning, #e3a008)";
  return "var(--muted-foreground, #8a8a8a)";
}

// --- rings ------------------------------------------------------------------

/**
 * Perimeter of a rounded rectangle inside the button; a square button gives a
 * circle. `inset` is the distance from the button edge to the stroke centre line.
 */
function ringPath(
  width: number,
  height: number,
  inset: number,
): { d: string; length: number } {
  const w = width - 2 * inset;
  const h = height - 2 * inset;
  const r = Math.min(w, h) / 2;
  const d = [
    // Start at top centre, then clockwise — as on any circular
    // indicator.
    `M${inset + w / 2} ${inset}`,
    `H${inset + w - r}`,
    `A${r} ${r} 0 0 1 ${inset + w} ${inset + r}`,
    `V${inset + h - r}`,
    `A${r} ${r} 0 0 1 ${inset + w - r} ${inset + h}`,
    `H${inset + r}`,
    `A${r} ${r} 0 0 1 ${inset} ${inset + h - r}`,
    `V${inset + r}`,
    `A${r} ${r} 0 0 1 ${inset + r} ${inset}`,
    "Z",
  ].join(" ");
  const length = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
  return { d, length };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Dimming of the unfilled track — shared with server-status. */
const TRACK_OPACITY = "0.22";

/** One ring: a grey track and a filled arc over it. */
class Ring {
  /** Both paths live in their own group so they hide and appear together. */
  readonly group: SVGGElement;
  private readonly track: SVGPathElement;
  private readonly value: SVGPathElement;
  private length = 0;

  constructor(stroke: number, private readonly inset: number) {
    this.group = document.createElementNS(SVG_NS, "g");

    this.track = document.createElementNS(SVG_NS, "path");
    this.track.setAttribute("stroke", "var(--muted-foreground, #8a8a8a)");
    this.track.setAttribute("stroke-width", String(stroke));
    this.track.setAttribute("stroke-opacity", TRACK_OPACITY);

    this.value = document.createElementNS(SVG_NS, "path");
    this.value.setAttribute("stroke-width", String(stroke));
    this.value.setAttribute("stroke-linecap", "round");
    this.value.style.transition =
      "stroke-dasharray 300ms ease, stroke 300ms ease";

    this.group.append(this.track, this.value);
  }

  /** Recomputes geometry for the current button size. */
  layout(width: number, height: number): void {
    const w = width - 2 * this.inset;
    const h = height - 2 * this.inset;
    // A collapsed sidebar can give a button narrower than the inner ring — then
    // it is simply absent, rather than drawn as an inside-out path.
    if (w <= 0 || h <= 0) {
      this.length = 0;
      this.group.style.display = "none";
      return;
    }
    this.group.style.display = "";
    const { d, length } = ringPath(width, height, this.inset);
    this.length = length;
    this.track.setAttribute("d", d);
    this.value.setAttribute("d", d);
  }

  /**
   * `percent` — the value of its own window, null — no window or a dead snapshot.
   * `track` — whether to show the grey track: on an unknown snapshot it stands
   * as a placeholder for figures to come; on a foreign set of windows there are no rings.
   */
  draw(percent: number | null, track: boolean): void {
    this.track.setAttribute("stroke-opacity", track ? TRACK_OPACITY : "0");
    this.value.setAttribute("stroke", ringColor(percent));
    const filled = ((percent ?? 0) / 100) * this.length;
    this.value.setAttribute("stroke-dasharray", `${filled} ${this.length}`);
    // A zero value has nothing to draw: a round stroke cap would leave a dot
    // at twelve o'clock, and an empty ring would look broken.
    this.value.setAttribute(
      "stroke-opacity",
      percent !== null && percent > 0 ? "1" : "0",
    );
  }
}

/** Radius of the marker dot for a ringless window, and of its background-coloured outline. */
const BADGE_RADIUS = 2.6;
const BADGE_HALO = 1.6;

/** The pair of rings as one layer over the host button. */
class Gauge {
  readonly node: HTMLSpanElement;
  private readonly svg: SVGSVGElement;
  private readonly outer = new Ring(OUTER_STROKE, OUTER_INSET);
  private readonly inner = new Ring(INNER_STROKE, INNER_INSET);
  /**
   * Marker for the window that got no ring. It sits on the outer ring in the
   * top right corner — where badges usually hang — and is separated from the
   * ring by an outline in the sidebar colour.
   */
  private readonly badge: SVGCircleElement;
  /** The marker place is known only after layout. */
  private badgeReady = false;

  constructor() {
    this.node = document.createElement("span");
    this.node.dataset.usageMeter = "rings";
    // The rings take no pointer events: clicks and the tooltip stay with the button.
    this.node.setAttribute(
      "style",
      "position:absolute;inset:0;pointer-events:none",
    );
    this.node.setAttribute("aria-hidden", "true");

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("fill", "none");
    this.svg.style.display = "block";
    this.svg.style.overflow = "visible";

    this.badge = document.createElementNS(SVG_NS, "circle");
    this.badge.setAttribute("r", String(BADGE_RADIUS));
    this.badge.setAttribute("stroke", "var(--sidebar, var(--background, #1b1b1b))");
    this.badge.setAttribute("stroke-width", String(BADGE_HALO));
    this.badge.style.display = "none";
    this.badge.style.transition = "fill 300ms ease";

    // The marker goes last: it sits above both rings.
    this.svg.append(this.outer.group, this.inner.group, this.badge);
    this.node.append(this.svg);
  }

  layout(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.outer.layout(width, height);
    this.inner.layout(width, height);
    // A point on the outer ring at 45° up and to the right: on a square button
    // that is the corner of the circle, on an elongated one the top right quarter.
    const w = width - 2 * OUTER_INSET;
    const h = height - 2 * OUTER_INSET;
    this.badgeReady = w > 2 * BADGE_RADIUS && h > 2 * BADGE_RADIUS;
    if (!this.badgeReady) {
      this.badge.style.display = "none";
      return;
    }
    const r = Math.min(w, h) / 2;
    const corner = r * Math.SQRT1_2;
    this.badge.setAttribute("cx", String(OUTER_INSET + w - r + corner));
    this.badge.setAttribute("cy", String(OUTER_INSET + r - corner));
  }

  /**
   * Values of the session and week windows plus `extra` — the highest ringless window.
   * While there is no snapshot (`known` = false) both rings stand grey and
   * empty, and the cause moves into the popup.
   */
  draw(
    session: number | null,
    weekly: number | null,
    known: boolean,
    extra: number | null,
  ): void {
    this.outer.draw(session, session !== null || !known);
    this.inner.draw(weekly, weekly !== null || !known);
    // The marker lights at exactly the threshold where the rings turn amber:
    // below it a ringless window bothers nobody, above it silence is not an option.
    const show = this.badgeReady && extra !== null && extra >= WARN;
    this.badge.style.display = show ? "" : "none";
    if (show) this.badge.setAttribute("fill", ringColor(extra));
  }
}

// --- popup ------------------------------------------------------------------

const PANEL_STYLE = [
  "position:fixed",
  "z-index:2147483000",
  "min-width:14rem",
  "max-width:20rem",
  "padding:0.5rem 0.625rem",
  "border:1px solid var(--border, rgba(128,128,128,0.3))",
  "border-radius:var(--radius, 0.5rem)",
  "background:var(--popover, var(--background, #1b1b1b))",
  "color:var(--popover-foreground, var(--foreground, #e5e5e5))",
  "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
  "font-size:0.8125rem",
  "font-family:inherit",
  "line-height:1.35",
].join(";");

const TITLE_STYLE = [
  "color:var(--muted-foreground, #9a9a9a)",
  "font-size:0.6875rem",
  "letter-spacing:0.04em",
  "text-transform:uppercase",
].join(";");

const MUTED_STYLE = "color:var(--muted-foreground, #9a9a9a)";

/**
 * A ring badge in a popup row. Button proportions do not read at that size —
 * the badge has its own radii, as long as the outer one stays thicker and
 * wider than the inner and the gap between them stays visible.
 */
const GLYPH_SIZE = 15;
const GLYPH_RINGS = [
  { key: "outer" as const, r: 6.4, stroke: 2 },
  { key: "inner" as const, r: 3.6, stroke: 1.3 },
];

function element(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Row badge: the same pair of rings in miniature, with its own ring picked out
 * in colour while the neighbour stays a track. It shows which row is which ring.
 */
function ringGlyph(which: "outer" | "inner", percent: number | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(GLYPH_SIZE));
  svg.setAttribute("height", String(GLYPH_SIZE));
  svg.setAttribute("viewBox", `0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const center = GLYPH_SIZE / 2;
  for (const { key, r, stroke } of GLYPH_RINGS) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(center));
    circle.setAttribute("cy", String(center));
    circle.setAttribute("r", String(r));
    circle.setAttribute("stroke-width", String(stroke));
    const own = key === which;
    circle.setAttribute(
      "stroke",
      own ? ringColor(percent) : "var(--muted-foreground, #8a8a8a)",
    );
    circle.setAttribute("stroke-opacity", own ? "1" : TRACK_OPACITY);
    svg.append(circle);
  }
  return svg;
}

/**
 * Row badge for a window without a ring: the same dot that lit up on the
 * button. It shows which window lit it.
 */
function dotGlyph(percent: number | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(GLYPH_SIZE));
  svg.setAttribute("height", String(GLYPH_SIZE));
  svg.setAttribute("viewBox", `0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(GLYPH_SIZE / 2));
  dot.setAttribute("cy", String(GLYPH_SIZE / 2));
  dot.setAttribute("r", String(BADGE_RADIUS));
  dot.setAttribute("fill", ringColor(percent));
  svg.append(dot);
  return svg;
}

/** The host portals tooltips straight into body — this is their wrapper. */
const HOST_TOOLTIP = "[data-radix-popper-content-wrapper]";

/**
 * Top edge of the host tooltip that would overlap the panel in this position;
 * null — nothing is in the way.
 */
function tooltipOver(box: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): number | null {
  let ceiling: number | null = null;
  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>(HOST_TOOLTIP),
  )) {
    const tip = node.getBoundingClientRect();
    if (tip.width === 0 || tip.height === 0) continue;
    if (tip.right <= box.left || tip.left >= box.right) continue;
    if (tip.bottom <= box.top || tip.top >= box.bottom) continue;
    ceiling = ceiling === null ? tip.top : Math.min(ceiling, tip.top);
  }
  return ceiling;
}

/** Panel with every limit window, the plan and the email. */
class Popup {
  private panel: HTMLDivElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private closeTimer: number | null = null;
  /**
   * Ceiling for the bottom edge of the panel: the host button tooltip hangs
   * above it and is wider, and the popup stands to the right — their corners
   * overlap. Once moved apart, the panel stays higher until it closes: otherwise
   * it would jump back and forth following the tooltip.
   */
  private ceiling: number | null = null;
  private placeFrame = 0;
  /** A popup opened by hover closes itself; a pinned one does not. */
  pinned = false;

  get isOpen(): boolean {
    return this.panel !== null;
  }

  private cancelClose = (): void => {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  };

  private armClose = (): void => {
    if (this.pinned) return;
    this.cancelClose();
    this.closeTimer = window.setTimeout(this.close, CLOSE_GRACE_MS);
  };

  close = (): void => {
    this.cancelClose();
    if (this.placeFrame !== 0) {
      window.cancelAnimationFrame(this.placeFrame);
      this.placeFrame = 0;
    }
    for (const off of this.cleanup.splice(0)) off();
    this.panel?.remove();
    this.panel = null;
    this.anchor = null;
    this.ceiling = null;
    this.pinned = false;
  };

  open(anchor: HTMLElement, state: UsageState | null, pinned: boolean): void {
    if (this.panel && this.anchor === anchor) {
      this.pinned = this.pinned || pinned;
      if (this.pinned) this.cancelClose();
      this.render(state);
      return;
    }
    this.close();
    this.pinned = pinned;
    this.anchor = anchor;

    const panel = document.createElement("div");
    panel.setAttribute("style", PANEL_STYLE);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Usage limits");
    panel.dataset.usageMeter = "popup";
    // Kept off screen until the height is known.
    panel.style.left = "-9999px";
    panel.style.top = "0";
    document.body.append(panel);
    this.panel = panel;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A click on the button itself is handled by its own listener.
      if (panel.contains(target) || anchor.contains(target)) return;
      this.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", this.close);
    panel.addEventListener("pointerenter", this.cancelClose);
    panel.addEventListener("pointerleave", this.armClose);
    // The button tooltip appears on its own delay, after the popup, and the
    // portal puts it straight into body. Wait for it, then give way.
    const portals = new MutationObserver(() => {
      if (this.placeFrame !== 0) return;
      this.placeFrame = window.requestAnimationFrame(() => {
        this.placeFrame = 0;
        this.place();
      });
    });
    portals.observe(document.body, { childList: true });
    this.cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("resize", this.close),
      () => portals.disconnect(),
    );

    this.render(state);
  }

  /** Redraw on a fresh snapshot — the popup can be open while polling. */
  render(state: UsageState | null): void {
    const panel = this.panel;
    if (!panel) return;
    panel.replaceChildren();

    panel.append(element("div", TITLE_STYLE, "Usage limits"));

    // Figures are shown after a failure too: they are old but real. An empty
    // panel remains only where there is nothing to show.
    const figures = hasFigures(state);
    if (!state || (state.status !== "ok" && !figures)) {
      panel.append(this.note(statusLine(state), "margin-top:0.375rem"));
      this.place();
      return;
    }

    if (state.planLabel) {
      panel.append(
        element("div", "margin-top:0.25rem;font-weight:500", state.planLabel),
      );
    }
    if (state.accountEmail) {
      panel.append(
        element("div", `${MUTED_STYLE};font-size:0.75rem`, state.accountEmail),
      );
    }

    const rows = element(
      "div",
      "margin-top:0.5rem;display:flex;flex-direction:column;gap:0.25rem",
    );
    let rings = false;
    for (const limit of state.windows) {
      const key = labelKey(limit.label);
      const row = element(
        "div",
        "display:flex;gap:0.375rem;align-items:center;min-width:0",
      );
      // Windows that have a ring are marked with it; a ringless window with the
      // same dot that lit on the button; the rest with an indent of the same
      // width, so the percentages stand in one column.
      const percent = percentOf(limit);
      const ring = ringOf(limit.label);
      if (ring) {
        rings = true;
        row.append(ringGlyph(ring, percent));
      } else if (percent !== null && percent >= WARN) {
        row.append(dotGlyph(percent));
      } else {
        row.append(element("span", `width:${GLYPH_SIZE}px;flex:none`));
      }

      // The API sets the window label, and a long one ("Claude Opus 4.6 extended
      // thinking window") has to be truncated inside the panel, not spill out.
      const label = element(
        "span",
        "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
        SHORT_LABEL[key] ?? limit.label,
      );
      if (!SHORT_LABEL[key]) label.title = limit.label;
      row.append(label);
      row.append(
        element(
          "span",
          "flex:none;white-space:nowrap",
          `${Math.round(limit.usedPercent)}%`,
        ),
      );
      const reset = resetText(limit.resetsAt);
      if (reset) {
        row.append(
          element(
            "span",
            `${MUTED_STYLE};font-size:0.75rem;flex:none;white-space:nowrap`,
            `· ${reset}`,
          ),
        );
      }
      rows.append(row);
    }
    if (state.windows.length === 0) {
      rows.append(element("div", MUTED_STYLE, "No limit windows"));
    }
    panel.append(rows);

    // These are the previous figures: without this row the rings would pass off old as fresh.
    if (state.status !== "ok") {
      panel.append(this.note(staleLine(state), "margin-top:0.375rem"));
    }
    // The thresholds are named in words: the neighbouring footer button uses
    // different ones, and a colour alone does not say at what percentage it lights.
    if (rings) {
      panel.append(
        this.note(
          {
            text: `Rings turn amber from ${WARN}% and red above ${DANGER}%`,
            title: null,
          },
          "margin-top:0.375rem;font-size:0.6875rem",
        ),
      );
    }
    panel.append(this.pageLink());
    this.place();
  }

  /**
   * The way out of the popup and into the Usage page. A real anchor, so
   * middle-clicking and copying the address work; an ordinary click is taken
   * over by the in-app navigation when React has left an opener behind.
   */
  private pageLink(): HTMLElement {
    const link = document.createElement("a");
    link.href = usagePanelHref();
    link.textContent = "More details →";
    link.setAttribute(
      "style",
      [
        "display:inline-block",
        "margin-top:0.5rem",
        "color:var(--primary, var(--foreground, #e5e5e5))",
        "text-decoration:none",
        "font-size:0.75rem",
      ].join(";"),
    );
    link.addEventListener("click", (event) => {
      // Modified clicks belong to the browser: a new tab is a legitimate answer.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      this.close();
      openUsagePanel();
    });
    return link;
  }

  /** A muted row at the bottom of the panel; unfamiliar text goes into the tooltip. */
  private note(line: Line, extra: string): HTMLElement {
    const node = element("div", `${MUTED_STYLE};${extra}`, line.text);
    if (line.title) node.title = line.title;
    return node;
  }

  /** To the right of the button, bottom edges aligned; always fits on screen. */
  private place(): void {
    const panel = this.panel;
    const anchor = this.anchor;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.right + 8),
      Math.max(8, window.innerWidth - size.width - 8),
    );
    let top = Math.min(
      Math.max(8, rect.bottom - size.height),
      Math.max(8, window.innerHeight - size.height - 8),
    );
    const tip = tooltipOver({
      left,
      top,
      right: left + size.width,
      bottom: top + size.height,
    });
    if (tip !== null) this.ceiling = Math.min(this.ceiling ?? tip, tip);
    // The panel rises above the tooltip. With no room above, it sticks to the
    // top of the screen: an overlap beats a panel that has left the edge.
    if (this.ceiling !== null) {
      top = Math.max(8, Math.min(top, this.ceiling - size.height - 8));
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** The cursor left the button: a hover popup closes, a pinned one lives on. */
  leave(): void {
    this.armClose();
  }

  enter(): void {
    this.cancelClose();
  }
}

// --- registration -----------------------------------------------------------

export default definePluginApp((app) => {
  // The page the rings are the short version of: the same limits on top, and
  // under them what the local transcripts say the limits were spent on.
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: PANEL_PATH,
    component: UsagePage,
    // Also the bridge the content script's "More details" link uses; see
    // lib/panel-link.ts.
    experimental_sidebarAccessory: UsageAccessory,
  });

  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Usage limits",
    icon: "ChartColumn",
    // Mouse and touch on the button are intercepted by the content script, but
    // keyboard activation lands here — the event opens the same popup.
    run: () => {
      document.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });

  app.contentScripts.register({
    id: "usage-rings",
    mount({ signal }) {
      const gauge = new Gauge();
      const popup = new Popup();
      let state: UsageState | null = null;
      let button: HTMLElement | null = null;
      // The button inline position from before us: the rings need a positioning
      // context, and on teardown the value goes back exactly as it was.
      let restorePosition: string | null = null;
      let hoverTimer: number | null = null;
      let suppressClick = false;
      let lastFetch = 0;
      let inFlight = false;

      const draw = () => {
        // A snapshot is "known" while it holds figures — fresh or previous. Empty
        // tracks for figures to come remain only for a cleared snapshot.
        const known = state?.status === "ok" || hasFigures(state);
        gauge.draw(
          percentOf(findWindow(state, SESSION_LABEL)),
          percentOf(findWindow(state, WEEKLY_LABEL)),
          known,
          extraMax(state),
        );
      };

      // The button size drives the ring geometry: the sidebar can collapse.
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.contentRect;
          const target = entry.target as HTMLElement;
          gauge.layout(
            target.offsetWidth || box.width,
            target.offsetHeight || box.height,
          );
        }
        draw();
      });

      const detach = () => {
        resizeObserver.disconnect();
        gauge.node.remove();
        if (button && restorePosition !== null) {
          button.style.position = restorePosition;
        }
        restorePosition = null;
        button = null;
      };

      const attach = (next: HTMLElement) => {
        if (button === next && gauge.node.parentNode === next) return;
        if (button !== next) detach();
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        // Placing a freshly created own node into the host container is allowed —
        // nodes it does not own are never moved or removed.
        next.append(gauge.node);
        gauge.layout(next.offsetWidth, next.offsetHeight);
        draw();
        resizeObserver.observe(next);
      };

      // The host renders the button, and it may not exist when the script starts —
      // wait for it, and at the same time restore the rings if React re-rendered
      // the footer and took the node away with the old button.
      let scheduled = 0;
      const sync = () => {
        scheduled = 0;
        const found = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        if (!found) {
          if (button) {
            popup.close();
            detach();
          }
          return;
        }
        attach(found);
      };
      const schedule = () => {
        if (scheduled !== 0) return;
        scheduled = window.requestAnimationFrame(sync);
      };
      const domObserver = new MutationObserver(() => {
        // A cheap check on every document mutation: while the button is the same
        // and the rings are in place, do nothing.
        if (button?.isConnected && gauge.node.parentNode === button) return;
        schedule();
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      sync();

      const refresh = async (force = false): Promise<void> => {
        // A hidden tab learns nothing from polling, and every open one would
        // otherwise keep poking the same server.
        if (document.visibilityState === "hidden" || inFlight || signal.aborted) {
          return;
        }
        const now = Date.now();
        if (!force && now - lastFetch < MIN_GAP_MS) return;
        lastFetch = now;
        inFlight = true;
        try {
          state = await fetchState(signal);
        } catch {
          // The network blinked or the server is restarting: show the previous
          // snapshot and wait for the next poll, without noise in the console.
          return;
        } finally {
          inFlight = false;
        }
        draw();
        popup.render(state);
      };

      void refresh(true);
      const timer = window.setInterval(() => void refresh(true), POLL_MS);

      // The tab came back from the background — its figures may have gone stale.
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.visibilityState === "visible") void refresh();
        },
        { signal },
      );

      const buttonFrom = (target: EventTarget | null): HTMLElement | null =>
        target instanceof Element
          ? (target.closest(BUTTON_SELECTOR) as HTMLElement | null)
          : null;

      const cancelHover = () => {
        if (hoverTimer !== null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
      };

      const toggle = () => {
        const anchor = button;
        if (!anchor) return;
        if (popup.isOpen && popup.pinned) {
          popup.close();
          return;
        }
        void refresh();
        popup.open(anchor, state, true);
      };

      // A mouse or finger press: pin the popup ourselves and swallow the click,
      // otherwise the host calls `run` and the popup closes right behind us.
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0 || !buttonFrom(event.target)) return;
          cancelHover();
          suppressClick = true;
          toggle();
        },
        { capture: true, signal },
      );

      document.addEventListener(
        "click",
        (event) => {
          if (!suppressClick || !buttonFrom(event.target)) return;
          suppressClick = false;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true, signal },
      );

      // Keyboard activation arrives from the `run` slot.
      document.addEventListener(TOGGLE_EVENT, () => toggle(), { signal });

      // Hover opens the same popup without a press. Mouse only: on touch,
      // "hover" is the start of a tap, and a tap is already handled above.
      document.addEventListener(
        "pointerover",
        (event) => {
          if (event.pointerType !== "mouse") return;
          const over = buttonFrom(event.target);
          if (!over) return;
          popup.enter();
          if (popup.isOpen || hoverTimer !== null) return;
          hoverTimer = window.setTimeout(() => {
            hoverTimer = null;
            if (!button) return;
            void refresh();
            popup.open(button, state, false);
          }, HOVER_MS);
        },
        { capture: true, signal },
      );

      document.addEventListener(
        "pointerout",
        (event) => {
          const out = buttonFrom(event.target);
          if (!out) return;
          // A move between the button own innards is not a leave.
          const to = event.relatedTarget;
          if (to instanceof Node && out.contains(to)) return;
          cancelHover();
          popup.leave();
        },
        { capture: true, signal },
      );

      return () => {
        cancelHover();
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
        window.clearInterval(timer);
        domObserver.disconnect();
        popup.close();
        detach();
      };
    },
  });
});
