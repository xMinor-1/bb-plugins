// bb-plugin-server-status — host health in the sidebar footer.
//
//   icon   — a host button next to the gear, the palette and the bug
//   ring   — RAM usage: muted, amber from 80%, red above 90%
//   click  — a panel with the full summary: CPU, memory, swap, disk,
//            load average, uptime, kernel and OS
//
// The host renders sidebarFooterAction as an icon only, so the ring comes
// from a content script: its own <svg> goes inside the host button over the
// icon, and the panel is plain DOM above the application. Nodes it does not
// own are never moved or removed; everything it owns goes on dispose.
//
// Ring geometry, thickness, corner radius and animation repeat the usage-meter
// plugin: two rings sit side by side in the footer and have to read as one
// system. Only the colour logic differs — the thresholds here are the owner's.
//
// A content script has no React hooks, so useRealtime is out of reach: the
// script polls the `state` rpc on the same 5-second tick the backend samples
// metrics on, and stays silent while the tab is hidden.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { Snapshot } from "./server";

const PLUGIN_ID = "server-status";
const ACTION_ID = "status";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;

// A bridge between the host's `run` and the content script: they live in
// different modules of one window, so keyboard activation arrives as an event.
const TOGGLE_EVENT = "server-status:toggle";

/** Poll tick — the same one the backend samples metrics on. */
const POLL_MS = 5_000;
/** Floor between polls: protection against frequent visibilitychange. */
const MIN_GAP_MS = 2_000;

/** Ring thickness — as in usage-meter, or two adjacent rings drift apart. */
const RING_STROKE = 2;

/** Colour thresholds for RAM (and for the bars in the panel). */
const WARN = 80;
const DANGER = 90;

// Below this, swap is barely touched — a permanent notice would be noise.
// Above it, memory no longer fits in RAM, and that is worth saying in words.
const SWAP_NOTE = 10;

const STYLE_ID = "bb-server-status-style";

// --- data -------------------------------------------------------------------

async function fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  const envelope = (await response.json()) as
    | { ok: true; result: Snapshot }
    | { ok: false; error?: { message?: string } };
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "rpc failed");
  return envelope.result;
}

// --- colours and levels -----------------------------------------------------

type Level = "ok" | "warn" | "danger";

function level(percent: number | null): Level {
  if (percent === null) return "ok";
  if (percent > DANGER) return "danger";
  if (percent >= WARN) return "warn";
  return "ok";
}

function levelColor(value: Level): string {
  if (value === "danger") return "var(--destructive, #e5484d)";
  if (value === "warn") return "var(--warning, #e3a008)";
  return "var(--muted-foreground, #8a8a8a)";
}

// --- formatting -------------------------------------------------------------

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

const NUM1 = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * The unit is written once per row, so the largest number in the row picks it
 * while every number in that row is printed in it: on a nine-terabyte volume
 * "9220 of 9313 GB used" does not read — "9.0 of 9.1 TB used" does.
 */
function scale(...bytes: number[]): { unit: string; format: (value: number) => string } {
  const tera = Math.max(...bytes) >= TIB;
  const divisor = tera ? TIB : GIB;
  return {
    unit: tera ? "TB" : "GB",
    // Past a hundred the fraction is noise: "104", not "104.3".
    format: (value: number): string => {
      const scaled = value / divisor;
      return scaled >= 100 ? String(Math.round(scaled)) : NUM1.format(scaled);
    },
  };
}

function percentText(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

/** One day, two days: English needs no table. */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function uptimeText(seconds: number): string {
  // "0 minutes" reads as a failure at exactly the moment uptime gets looked at —
  // in the first minute after a reboot.
  if (seconds < 60) return "less than a minute";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${days} ${plural(days, "day")} ${hours} ${plural(hours, "hour")}`;
  }
  if (hours > 0) {
    return `${hours} ${plural(hours, "hour")} ${minutes} ${plural(minutes, "minute")}`;
  }
  return `${minutes} ${plural(minutes, "minute")}`;
}

const BOOT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const BOOT_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

/** "1 August 2026, 17:03" — a date a person reads, not a timestamp. */
function bootedText(ms: number): string {
  const at = new Date(ms);
  return `${BOOT_DATE.format(at)}, ${BOOT_TIME.format(at)}`;
}

// Uptime grows from a boot moment the server reported once, so an open tab
// counts on its own instead of asking again.
function uptimeSeconds(snapshot: Snapshot): number {
  const grown = Math.round((Date.now() - snapshot.bootTimeMs) / 1000);
  return Number.isFinite(grown) && grown > 0 ? grown : snapshot.uptimeSeconds;
}

// --- ring -------------------------------------------------------------------

/** Perimeter of a rounded rectangle along the button edge; a square gives a circle. */
function ringPath(width: number, height: number): { d: string; length: number } {
  const inset = RING_STROKE / 2;
  const w = Math.max(0, width - RING_STROKE);
  const h = Math.max(0, height - RING_STROKE);
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

/** An own node over the host button: a track and a filled arc. */
class Ring {
  readonly node: HTMLSpanElement;
  private readonly svg: SVGSVGElement;
  private readonly track: SVGPathElement;
  private readonly value: SVGPathElement;
  private length = 0;

  constructor() {
    this.node = document.createElement("span");
    this.node.dataset.serverStatus = "ring";
    // The ring takes no pointer events: clicks and the tooltip stay with the button.
    this.node.setAttribute("style", "position:absolute;inset:0;pointer-events:none");
    this.node.setAttribute("aria-hidden", "true");

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("fill", "none");
    this.svg.style.display = "block";
    this.svg.style.overflow = "visible";

    this.track = document.createElementNS(SVG_NS, "path");
    this.track.setAttribute("stroke", "var(--muted-foreground, #8a8a8a)");
    this.track.setAttribute("stroke-width", String(RING_STROKE));
    this.track.setAttribute("stroke-opacity", "0.22");

    this.value = document.createElementNS(SVG_NS, "path");
    this.value.setAttribute("stroke-width", String(RING_STROKE));
    this.value.setAttribute("stroke-linecap", "round");
    this.value.style.transition = "stroke-dasharray 300ms ease, stroke 300ms ease";

    this.svg.append(this.track, this.value);
    this.node.append(this.svg);
  }

  /** Recomputes geometry for the current button size. */
  layout(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const { d, length } = ringPath(width, height);
    this.length = length;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.track.setAttribute("d", d);
    this.value.setAttribute("d", d);
  }

  /** The ring shows RAM usage; null means no snapshot yet, track only. */
  draw(percent: number | null): void {
    const known = percent !== null;
    const safe = known ? Math.min(100, Math.max(0, percent)) : 0;
    const filled = (safe / 100) * this.length;
    this.value.setAttribute("stroke", levelColor(level(percent)));
    this.value.setAttribute("stroke-dasharray", `${filled} ${this.length}`);
    this.value.setAttribute("stroke-opacity", known && safe > 0 ? "1" : "0");
  }
}

// --- panel ------------------------------------------------------------------

// The panel lives in document.body above the application, so its styles stay
// in an own sheet that is removed with everything else on dispose.
const CSS = `
[data-server-status="panel"] {
  position: fixed;
  z-index: 2147483000;
  /* Wide enough for "Last reboot: 1 August 2026, 17:03" to fit on one line —
     the panel is read, not decoded. */
  width: 21rem;
  max-width: calc(100vw - 1rem);
  max-height: calc(100vh - 1rem);
  overflow-y: auto;
  padding: 0.75rem 0.875rem 0.8125rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  border-radius: var(--radius, 0.5rem);
  background: var(--popover, var(--background, #1b1b1b));
  color: var(--popover-foreground, var(--foreground, #e5e5e5));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.bb-ss-title {
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.6875rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.bb-ss-host {
  margin-top: 0.125rem;
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-metric { margin-top: 0.6875rem; }
.bb-ss-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.bb-ss-name { font-weight: 500; }
.bb-ss-mount {
  margin-left: 0.25rem;
  color: var(--muted-foreground, #9a9a9a);
  font-weight: 400;
  font-size: 0.75rem;
}
.bb-ss-value[data-level="warn"] { color: var(--warning, #e3a008); }
.bb-ss-value[data-level="danger"] { color: var(--destructive, #e5484d); }
.bb-ss-bar {
  position: relative;
  height: 3px;
  margin-top: 0.3125rem;
  border-radius: 999px;
}
.bb-ss-track {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--muted-foreground, #8a8a8a);
  opacity: 0.22;
}
.bb-ss-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
  background: var(--muted-foreground, #8a8a8a);
  /* The same duration as the ring: two scales move in step. */
  transition: width 300ms ease, background-color 300ms ease;
}
.bb-ss-fill[data-level="warn"] { background: var(--warning, #e3a008); }
.bb-ss-fill[data-level="danger"] { background: var(--destructive, #e5484d); }
.bb-ss-detail {
  margin-top: 0.25rem;
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-note {
  margin-top: 0.3125rem;
  padding: 0.3125rem 0.4375rem;
  border-radius: calc(var(--radius, 0.5rem) - 0.25rem);
  background: color-mix(in srgb, var(--warning, #e3a008) 14%, transparent);
  color: var(--warning, #e3a008);
  font-size: 0.75rem;
}
.bb-ss-foot {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-foot div + div { margin-top: 0.125rem; }
.bb-ss-stale {
  margin-top: 0.375rem;
  color: var(--destructive, #e5484d);
  font-size: 0.75rem;
}
[data-server-status="panel"] [hidden] { display: none; }
`;

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One panel metric: name, percentage, bar and a details row. */
class MetricRow {
  readonly root: HTMLDivElement;
  private readonly mount: HTMLSpanElement;
  private readonly value: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly detail: HTMLDivElement;

  constructor(name: string) {
    this.root = div("bb-ss-metric");
    const head = div("bb-ss-head");
    const title = document.createElement("span");
    title.className = "bb-ss-name";
    title.textContent = name;
    this.mount = document.createElement("span");
    this.mount.className = "bb-ss-mount";
    title.append(this.mount);
    this.value = document.createElement("span");
    this.value.className = "bb-ss-value";
    head.append(title, this.value);

    const bar = div("bb-ss-bar");
    this.fill = div("bb-ss-fill");
    this.fill.style.width = "0%";
    bar.append(div("bb-ss-track"), this.fill);

    this.detail = div("bb-ss-detail");
    this.root.append(head, bar, this.detail);
  }

  update(percent: number | null, detail: string, mount = ""): void {
    const state = level(percent);
    this.value.textContent = percentText(percent);
    this.value.dataset.level = state;
    this.fill.style.width = `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%`;
    this.fill.dataset.level = state;
    this.detail.textContent = detail;
    this.mount.textContent = mount;
  }

  set hidden(value: boolean) {
    this.root.hidden = value;
  }
}

/**
 * The full summary panel. The structure is built once, and only the values
 * change afterwards — that way bars animate into place instead of jumping.
 */
class Panel {
  private node: HTMLDivElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private host!: HTMLDivElement;
  private cpu!: MetricRow;
  private memory!: MetricRow;
  private swap!: MetricRow;
  private disk!: MetricRow;
  private swapNote!: HTMLDivElement;
  private loadAvg!: HTMLDivElement;
  private uptime!: HTMLDivElement;
  private booted!: HTMLDivElement;
  private stale!: HTMLDivElement;

  constructor(private readonly onClose: () => void) {}

  get isOpen(): boolean {
    return this.node !== null;
  }

  private build(): HTMLDivElement {
    const node = div("");
    node.dataset.serverStatus = "panel";
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "Server status");
    node.tabIndex = -1;

    this.host = div("bb-ss-host");
    this.cpu = new MetricRow("CPU");
    this.memory = new MetricRow("Memory");
    this.swap = new MetricRow("Swap");
    this.disk = new MetricRow("Disk");
    this.swapNote = div("bb-ss-note");
    this.swapNote.hidden = true;

    const foot = div("bb-ss-foot");
    this.loadAvg = div("");
    this.uptime = div("");
    this.booted = div("");
    foot.append(this.loadAvg, this.uptime, this.booted);

    this.stale = div("bb-ss-stale", "The last poll failed — these numbers may be stale.");
    this.stale.hidden = true;

    node.append(
      div("bb-ss-title", "Server status"),
      this.host,
      this.cpu.root,
      this.memory.root,
      this.swap.root,
      this.swapNote,
      this.disk.root,
      foot,
      this.stale,
    );
    return node;
  }

  open(anchor: HTMLElement, snapshot: Snapshot | null, stale: boolean): void {
    if (this.node) {
      this.anchor = anchor;
      this.update(snapshot, stale);
      return;
    }
    this.anchor = anchor;
    const node = this.build();
    // Kept off screen until the height is known.
    node.style.left = "-9999px";
    node.style.top = "0";
    document.body.append(node);
    this.node = node;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A click on the button itself is handled by its own listener.
      if (node.contains(target) || anchor.contains(target)) return;
      this.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.close();
      // Focus goes back to the button: the panel was closed from the keyboard.
      anchor.focus?.();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", this.close);
    this.cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("resize", this.close),
    );

    this.update(snapshot, stale);
  }

  close = (): void => {
    if (!this.node) return;
    for (const off of this.cleanup.splice(0)) off();
    this.node.remove();
    this.node = null;
    this.anchor = null;
    this.onClose();
  };

  /** Redraw on a fresh snapshot — the panel can be open while polling. */
  update(snapshot: Snapshot | null, stale: boolean): void {
    if (!this.node) return;

    if (!snapshot) {
      this.host.textContent = "Waiting for the first sample…";
      for (const row of [this.cpu, this.memory, this.swap, this.disk]) {
        row.hidden = true;
      }
      this.swapNote.hidden = true;
      this.loadAvg.textContent = "";
      this.uptime.textContent = "";
      this.booted.textContent = "";
      this.stale.hidden = !stale;
      this.place();
      return;
    }

    this.host.textContent = `${snapshot.osName} · kernel ${snapshot.kernel}`;

    this.cpu.hidden = false;
    this.cpu.update(
      snapshot.cpu,
      `${snapshot.cores} ${plural(snapshot.cores, "core")}`,
    );

    const memory = snapshot.memory;
    const inMemory = scale(memory.usedBytes, memory.totalBytes);
    this.memory.hidden = false;
    this.memory.update(
      memory.percent,
      `${inMemory.format(memory.usedBytes)} of` +
        ` ${inMemory.format(memory.totalBytes)} ${inMemory.unit} used`,
    );

    const swap = snapshot.swap;
    this.swap.hidden = swap === null;
    this.swapNote.hidden = true;
    if (swap) {
      const inSwap = scale(swap.usedBytes, swap.totalBytes);
      this.swap.update(
        swap.percent,
        `${inSwap.format(swap.usedBytes)} of` +
          ` ${inSwap.format(swap.totalBytes)} ${inSwap.unit} used`,
      );
      // A separate warning row: swap is memory pushed out to disk. A percentage
      // on its own explains nothing, so a warning in words appears underneath.
      if (swap.percent >= WARN) {
        this.swapNote.hidden = false;
        this.swapNote.textContent =
          "Swap is nearly full: RAM has run out and the server may slow down noticeably.";
      } else if (swap.percent >= SWAP_NOTE) {
        this.swapNote.hidden = false;
        this.swapNote.textContent =
          "Some memory has been pushed out to disk — the server no longer fits in RAM.";
      }
    }

    const disk = snapshot.disk;
    this.disk.hidden = disk === null;
    if (disk) {
      const inDisk = scale(disk.usedBytes, disk.totalBytes, disk.availBytes);
      this.disk.update(
        disk.percent,
        `${inDisk.format(disk.usedBytes)} of` +
          ` ${inDisk.format(disk.totalBytes)} ${inDisk.unit} used` +
          ` · ${inDisk.format(disk.availBytes)} ${inDisk.unit} free`,
        // Labelling the root is pointless — the row already says "Disk". Any
        // other mount point is shown: without it the numbers have no subject.
        disk.path === "/" ? "" : disk.path,
      );
    }

    // "1.5 / 1.4 / 0.9" with no caption reads as a riddle: say that these are
    // three averaging windows, and what to compare them against — the core count.
    const load = snapshot.load.map((value) => NUM1.format(value)).join(" / ");
    this.loadAvg.textContent =
      `Load average over 1, 5 and 15 minutes: ${load}` +
      ` (overload starts at ${snapshot.cores})`;
    this.uptime.textContent = `Up without a reboot: ${uptimeText(uptimeSeconds(snapshot))}`;
    this.booted.textContent = `Last reboot: ${bootedText(snapshot.bootTimeMs)}`;
    this.stale.hidden = !stale;
    this.place();
  }

  /** To the right of the button, bottom edges aligned; always fits on screen. */
  place(): void {
    const node = this.node;
    const anchor = this.anchor;
    if (!node || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    // With no room on the right (a narrow screen) the panel moves left of the button.
    const fitsRight = rect.right + 8 + size.width + 8 <= window.innerWidth;
    const preferred = fitsRight ? rect.right + 8 : rect.left - size.width - 8;
    // On a narrow screen the sidebar slides past the left edge, and the button
    // with it: without a floor the panel would follow and be clipped.
    const left = Math.min(
      Math.max(8, preferred),
      Math.max(8, window.innerWidth - size.width - 8),
    );
    const top = Math.min(
      Math.max(8, rect.bottom - size.height),
      Math.max(8, window.innerHeight - size.height - 8),
    );
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
}

// --- registration -----------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Server status",
    icon: "Activity",
    // Mouse and touch on the button are intercepted by the content script, but
    // keyboard activation lands here — the event opens the same panel.
    run: () => {
      document.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });

  app.contentScripts.register({
    id: "footer-status",
    mount({ signal }) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);

      const ring = new Ring();
      let pinned = false;
      const panel = new Panel(() => {
        pinned = false;
      });
      let snapshot: Snapshot | null = null;
      let stale = false;
      let button: HTMLElement | null = null;
      // The button's inline position from before us: the ring needs a positioning
      // context, and on teardown the value goes back exactly as it was.
      let restorePosition: string | null = null;
      // The pointer whose press on the button we already handled ourselves: its
      // paired click — and only its — must be swallowed. An id is stored rather
      // than a bare flag: a gesture can be cancelled (pressed on the icon,
      // released aside), then no click on the button arrives at all and a raised
      // flag would eat the next keyboard activation.
      let suppressedPointer: number | null = null;
      let inFlight = false;
      let lastFetch = 0;

      const draw = () => ring.draw(snapshot ? snapshot.memory.percent : null);

      // The button size drives the ring geometry: the sidebar can collapse.
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.contentRect;
          const target = entry.target as HTMLElement;
          ring.layout(target.offsetWidth || box.width, target.offsetHeight || box.height);
        }
        draw();
        panel.place();
      });

      const detach = () => {
        resizeObserver.disconnect();
        ring.node.remove();
        if (button && restorePosition !== null) button.style.position = restorePosition;
        restorePosition = null;
        button = null;
      };

      const attach = (next: HTMLElement) => {
        if (button === next && ring.node.parentNode === next) return;
        if (button !== next) detach();
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        // Placing a freshly created own node into the host container is allowed —
        // nodes it does not own are never moved or removed.
        next.append(ring.node);
        ring.layout(next.offsetWidth, next.offsetHeight);
        draw();
        resizeObserver.observe(next);
      };

      // The host renders the button, and it may not exist when the script starts —
      // wait for it, and at the same time restore the ring if React re-rendered
      // the footer and took the node away with the old button.
      let scheduled = 0;
      const sync = () => {
        scheduled = 0;
        const found = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        if (!found) {
          if (button) {
            panel.close();
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
        // and the ring is in place, do nothing.
        if (button?.isConnected && ring.node.parentNode === button) return;
        schedule();
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      sync();

      const refresh = async (force = false): Promise<void> => {
        // A hidden tab learns nothing from polling, and every open one would
        // otherwise keep poking the same server.
        if (document.visibilityState === "hidden" || inFlight || signal.aborted) return;
        const now = Date.now();
        if (!force && now - lastFetch < MIN_GAP_MS) return;
        lastFetch = now;
        inFlight = true;
        try {
          snapshot = await fetchSnapshot(signal);
          stale = false;
        } catch {
          // The server can restart the plugin: keep the previous numbers, mark
          // them stale and wait for the next tick. Nothing goes to the console —
          // once every five seconds that would be a wall of messages.
          stale = snapshot !== null;
        } finally {
          inFlight = false;
        }
        draw();
        panel.update(snapshot, stale);
      };

      void refresh(true);
      const timer = window.setInterval(() => void refresh(true), POLL_MS);

      // The tab came back from the background — its numbers went stale meanwhile.
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

      const toggle = () => {
        const anchor = button;
        if (!anchor) return;
        if (pinned) {
          panel.close();
          return;
        }
        pinned = true;
        void refresh();
        panel.open(anchor, snapshot, stale);
      };

      // A mouse or finger press: open the panel ourselves and swallow the click,
      // otherwise the host calls `run` and the panel closes right behind us.
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0 || !buttonFrom(event.target)) return;
          suppressedPointer = event.pointerId;
          toggle();
        },
        { capture: true, signal },
      );

      // End of the gesture. Released on the button — a paired click is coming and
      // the listener below swallows it. Released elsewhere or cancelled — no click
      // on the button will arrive, and the expectation has to be cleared here or
      // it would be spent on the next Enter or Space.
      const endGesture = (event: PointerEvent) => {
        if (suppressedPointer !== event.pointerId) return;
        if (event.type === "pointerup" && buttonFrom(event.target)) return;
        suppressedPointer = null;
      };
      document.addEventListener("pointerup", endGesture, { capture: true, signal });
      document.addEventListener("pointercancel", endGesture, { capture: true, signal });

      document.addEventListener(
        "click",
        (event) => {
          if (suppressedPointer === null || !buttonFrom(event.target)) return;
          suppressedPointer = null;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true, signal },
      );

      // Keyboard activation arrives from the `run` slot.
      document.addEventListener(TOGGLE_EVENT, () => toggle(), { signal });

      return () => {
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
        window.clearInterval(timer);
        domObserver.disconnect();
        panel.close();
        detach();
        style.remove();
      };
    },
  });
});
