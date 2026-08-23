// Theme button in the sidebar footer.
//   short click        — flip light ⇄ dark
//   hold / right-click — menu: light / dark / system + the palette list
//   hover and wait     — the same menu, without pressing anything (mouse only)
//
// sidebarFooterAction is rendered by the host, so the long-press is attached by
// a content script to the host's own button markup (stable data-testid), and
// the menu is drawn as plain DOM on top of the app. The same content script
// repaints the button's artwork, so the switch on it shows the appearance the
// click would leave behind.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "theme-toggle";
const ACTION_ID = "toggle-theme";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;
const HOLD_MS = 400;
// Hovering opens the same menu, so the button answers a resting cursor without
// a click. Long enough that a cursor crossing the footer never triggers it.
const HOVER_MS = 600;
// A hover-opened menu closes itself once the cursor leaves; the grace period
// covers the gap the cursor crosses between the button and the panel.
const CLOSE_GRACE_MS = 250;

// Appearance is a client-side bb setting (jotai atomWithStorage, raw string).
// The key and its values match the app's own useTheme.
const MODE_KEY = "bb.theme";
type Mode = "light" | "dark" | "system";
const MODES: Array<{ id: Mode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function readMode(): Mode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function writeMode(mode: Mode): void {
  const previous = (() => {
    try {
      return localStorage.getItem(MODE_KEY);
    } catch {
      return null;
    }
  })();
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode — the class toggle below still applies */
  }
  // bb reads this key through atomWithStorage, which listens for `storage`.
  // The originating tab never receives that event, so dispatch a synthetic one
  // and let the app re-render normally instead of only swapping the class.
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: MODE_KEY,
      oldValue: previous,
      newValue: mode,
      storageArea: localStorage,
    }),
  );
  // Fallback if the event does not land: `dark` is the class the CSS reads.
  const resolved =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function resolvedMode(): "light" | "dark" {
  const mode = readMode();
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// --- artwork ----------------------------------------------------------------

// The button wears the square from icon.svg, cut from the top-right corner to
// the bottom-left one: day above the cut, night below it. The half that is on
// is filled and holds its symbol punched through, the other half is an empty
// outline with its symbol drawn small — so the fill moves from one half to the
// other on every flip. BB renders branding.icon as a CSS mask over a span
// inside its own button, so swapping that one mask keeps the host's chrome
// untouched. Keep the night face here identical to icon.svg — that file is the
// still version bb shows in the plugin catalog.
//
// A mask image reads alpha, so the symbol on the filled half is cut out
// through an SVG mask instead of being painted in a lighter colour. The
// drawing fills the whole canvas, and the span is scaled up past the host's
// 16 px, which puts the square level with the rings other footer plugins draw.
const ICON_SCALE = 1.65;

const ICON_SUN_CUT =
  '<circle cx="7.6" cy="7.6" r="2.5" fill="#000"/>' +
  '<g stroke="#000" stroke-width="1.3" stroke-linecap="round">' +
  '<path d="M10.74 8.9L11.48 9.21M8.9 10.74L9.21 11.48M6.3 10.74L5.99 11.48M4.46 8.9L3.72 9.21M4.46 6.3L3.72 5.99M6.3 4.46L5.99 3.72M8.9 4.46L9.21 3.72M10.74 6.3L11.48 5.99"/>' +
  "</g>";
const ICON_SUN_SMALL =
  '<circle cx="6.8" cy="6.8" r="1.9" fill="#000"/>' +
  '<g stroke="#000" stroke-width="1.25" stroke-linecap="round">' +
  '<path d="M9.29 7.83L9.85 8.06M7.83 9.29L8.06 9.85M5.77 9.29L5.54 9.85M4.31 7.83L3.75 8.06M4.31 5.77L3.75 5.54M5.77 4.31L5.54 3.75M7.83 4.31L8.06 3.75M9.29 5.77L9.85 5.54"/>' +
  "</g>";
// Both crescents are mirrored about their own centre, so the moon opens toward
// the diagonal rather than away from it.
const ICON_MOON_CUT =
  '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="#000" transform="translate(32.8 0) scale(-1 1) translate(10.8 10.8) scale(0.4667)"/>';
const ICON_MOON_SMALL =
  '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="#000" transform="translate(34.4 0) scale(-1 1) translate(13.333 13.333) scale(0.3222)"/>';

// The diagonal runs corner to corner with a gap either side, so each half is
// clipped a unit short of it. The outline half also needs the cut drawn in, or
// its third side is missing.
const ICON_HALVES = {
  day: { clip: '<polygon points="0,0 23,0 0,23"/>', cut: "M21.8 0.2L0.2 21.8" },
  night: { clip: '<polygon points="24,1 24,24 1,24"/>', cut: "M23.8 2.2L2.2 23.8" },
} as const;

function iconUrl(lit: "day" | "night", punched: string, drawn: string): string {
  const idle = lit === "day" ? "night" : "day";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<clipPath id="s"><rect width="24" height="24" rx="5"/></clipPath>' +
    `<clipPath id="a">${ICON_HALVES[lit].clip}</clipPath>` +
    `<clipPath id="b">${ICON_HALVES[idle].clip}</clipPath>` +
    '<defs><mask id="c" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">' +
    '<rect width="24" height="24" fill="#fff"/>' +
    punched +
    "</mask></defs>" +
    '<g clip-path="url(#s)">' +
    '<g clip-path="url(#a)"><rect width="24" height="24" rx="5" fill="#000" mask="url(#c)"/></g>' +
    '<g clip-path="url(#b)">' +
    '<rect x="1" y="1" width="22" height="22" rx="4" fill="none" stroke="#000" stroke-width="2"/>' +
    `<path d="${ICON_HALVES[idle].cut}" fill="none" stroke="#000" stroke-width="2"/>` +
    "</g>" +
    drawn +
    "</g></svg>";
  // encodeURIComponent leaves brackets alone, and an unescaped one inside a
  // data URI ends the CSS url() token early — the declaration is then dropped
  // and the button silently keeps the face it had.
  const encoded = encodeURIComponent(svg)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `url("data:image/svg+xml,${encoded}")`;
}

const ICON_NIGHT = iconUrl("night", ICON_MOON_CUT, ICON_SUN_SMALL);
const ICON_DAY = iconUrl("day", ICON_SUN_CUT, ICON_MOON_SMALL);

// bb marks the masked span with the asset it painted; without it the host fell
// back to a named icon, and there is nothing to repaint.
const ICON_SELECTOR = "[data-plugin-icon-asset]";

function paintIcon(): void {
  const icon = document
    .querySelector(BUTTON_SELECTOR)
    ?.querySelector<HTMLElement>(ICON_SELECTOR);
  if (!icon) return;
  const url = resolvedMode() === "dark" ? ICON_NIGHT : ICON_DAY;
  icon.style.setProperty("mask-image", url);
  icon.style.setProperty("-webkit-mask-image", url);
  // Scaling instead of resizing: the span keeps its 16 px slot, so the footer
  // row never reflows around a bigger icon.
  icon.style.setProperty("transform", `scale(${ICON_SCALE})`);
}

type ThemeState = {
  activeId: string;
  themes: Array<{ id: string; name: string }>;
};

async function callRpc(method: string, input: unknown = null): Promise<ThemeState> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const envelope = await response.json();
  if (!envelope?.ok) {
    throw new Error(envelope?.error?.message ?? "rpc failed");
  }
  return envelope.result as ThemeState;
}

// --- menu -------------------------------------------------------------------

const PANEL_STYLE = [
  "position:fixed",
  "z-index:2147483000",
  "min-width:13rem",
  "padding:0.25rem",
  "border:1px solid var(--border, rgba(128,128,128,0.3))",
  "border-radius:var(--radius, 0.5rem)",
  "background:var(--popover, var(--background, #1b1b1b))",
  "color:var(--popover-foreground, var(--foreground, #e5e5e5))",
  "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
  "font-size:0.8125rem",
  "font-family:inherit",
].join(";");

const ROW_STYLE = [
  "display:flex",
  "align-items:center",
  "gap:0.5rem",
  "width:100%",
  "padding:0.375rem 0.5rem",
  "border:0",
  "border-radius:calc(var(--radius, 0.5rem) - 0.25rem)",
  "background:transparent",
  "color:inherit",
  "font:inherit",
  "text-align:left",
  "cursor:pointer",
].join(";");

const LABEL_STYLE = [
  "padding:0.375rem 0.5rem 0.25rem",
  "color:var(--muted-foreground, #9a9a9a)",
  "font-size:0.6875rem",
  "letter-spacing:0.04em",
  "text-transform:uppercase",
].join(";");

function makeRow(
  label: string,
  checked: boolean,
  onPick: () => void,
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.setAttribute("style", ROW_STYLE);
  row.setAttribute("role", "menuitemradio");
  row.setAttribute("aria-checked", String(checked));

  const mark = document.createElement("span");
  mark.textContent = checked ? "✓" : "";
  mark.setAttribute("style", "width:0.75rem;flex:none;opacity:0.9");

  const text = document.createElement("span");
  text.textContent = label;
  text.setAttribute("style", "flex:1;min-width:0");

  row.append(mark, text);
  row.addEventListener("mouseenter", () => {
    row.style.background = "var(--accent, rgba(128,128,128,0.18))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "transparent";
  });
  row.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick();
  });
  return row;
}

function makeSeparator(): HTMLDivElement {
  const line = document.createElement("div");
  line.setAttribute(
    "style",
    "margin:0.25rem 0.25rem;height:1px;background:var(--border, rgba(128,128,128,0.3))",
  );
  return line;
}

class ThemeMenu {
  private panel: HTMLDivElement | null = null;
  private cleanup: Array<() => void> = [];
  private closeTimer: number | null = null;
  // A hover-opened menu was not asked for, so a click on the button should
  // still flip the appearance; a held-open one swallows that click instead.
  openedByHover = false;

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
    this.cancelClose();
    this.closeTimer = window.setTimeout(this.close, CLOSE_GRACE_MS);
  };

  close = (): void => {
    this.cancelClose();
    for (const off of this.cleanup.splice(0)) off();
    this.panel?.remove();
    this.panel = null;
    this.openedByHover = false;
  };

  async open(anchor: HTMLElement, byHover = false): Promise<void> {
    this.close();
    this.openedByHover = byHover;
    const panel = document.createElement("div");
    panel.setAttribute("style", PANEL_STYLE);
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "Appearance");
    // Park it off-screen until the height is known.
    panel.style.left = "-9999px";
    panel.style.top = "0";
    document.body.append(panel);
    this.panel = panel;

    const onPointerDown = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) && event.target !== anchor) {
        this.close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", this.close);
    this.cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("resize", this.close),
    );

    if (byHover) {
      panel.addEventListener("pointerenter", this.cancelClose);
      panel.addEventListener("pointerleave", this.armClose);
      anchor.addEventListener("pointerenter", this.cancelClose);
      anchor.addEventListener("pointerleave", this.armClose);
      this.cleanup.push(
        () => anchor.removeEventListener("pointerenter", this.cancelClose),
        () => anchor.removeEventListener("pointerleave", this.armClose),
      );
    }

    const render = (state: ThemeState) => {
      if (this.panel !== panel) return;
      panel.replaceChildren();

      const modeLabel = document.createElement("div");
      modeLabel.textContent = "Appearance";
      modeLabel.setAttribute("style", LABEL_STYLE);
      panel.append(modeLabel);

      const mode = readMode();
      for (const item of MODES) {
        panel.append(
          makeRow(item.label, item.id === mode, () => {
            writeMode(item.id);
            render(state);
          }),
        );
      }

      panel.append(makeSeparator());
      const paletteLabel = document.createElement("div");
      paletteLabel.textContent = "Palette";
      paletteLabel.setAttribute("style", LABEL_STYLE);
      panel.append(paletteLabel);

      for (const theme of state.themes) {
        panel.append(
          makeRow(theme.name, theme.id === state.activeId, () => {
            void callRpc("select", { themeId: theme.id })
              .then(render)
              .catch((error: unknown) =>
                toast.error(`Could not change the palette: ${String(error)}`),
              );
          }),
        );
      }
      place();
    };

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, rect.right + 8),
        Math.max(8, window.innerWidth - size.width - 8),
      );
      const top = Math.min(
        Math.max(8, rect.bottom - size.height),
        Math.max(8, window.innerHeight - size.height - 8),
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    try {
      render(await callRpc("state"));
    } catch (error) {
      this.close();
      toast.error(`Could not load the themes: ${String(error)}`);
    }
  }
}

// --- registration -----------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Theme: click for light or dark, hold to choose",
    // Only reached if the artwork fails to load: bb prefers branding.icon.
    icon: "Palette",
    run: () => {
      // A click is a plain day/night flip, so it leaves "system" behind and
      // starts from whatever that was showing. The whole app changing colour
      // is the confirmation; no toast on top of it.
      writeMode(resolvedMode() === "dark" ? "light" : "dark");
    },
  });

  app.contentScripts.register({
    id: "theme-hold-menu",
    mount({ signal }) {
      const menu = new ThemeMenu();
      let holdTimer: number | null = null;
      let hoverTimer: number | null = null;
      let suppressClick = false;
      // Set while the cursor rests on the button after a press: without it the
      // menu would pop up again on its own right after every click.
      let hoverBlocked = false;

      // The artwork follows the appearance. Repainting is idempotent and only
      // costs a lookup, so every plausible trigger calls it: the host redrawing
      // its footer, the setting changing here or in another tab, the system
      // switching over, and the cursor arriving on the button — the last one
      // covers a sidebar that remounted out of the observer's reach.
      const footerObserver = new MutationObserver(() => paintIcon());
      let observedFooter: HTMLElement | null = null;
      let findTimer: number | null = null;

      const sync = (): void => {
        const button = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        // The footer list outlives the button, which the host re-keys whenever
        // the plugin reloads, so the list is what we watch.
        const footer = button?.parentElement?.parentElement ?? null;
        if (footer && footer !== observedFooter) {
          footerObserver.disconnect();
          footerObserver.observe(footer, { childList: true, subtree: true });
          observedFooter = footer;
        }
        paintIcon();
      };

      // The sidebar may render after the plugin mounts; give it a while.
      let attempts = 0;
      const waitForButton = (): void => {
        findTimer = null;
        sync();
        if (observedFooter || ++attempts > 40) return;
        findTimer = window.setTimeout(waitForButton, 500);
      };
      waitForButton();

      // writeMode dispatches this synthetically, so both halves land here.
      window.addEventListener(
        "storage",
        (event) => {
          if (event.key === null || event.key === MODE_KEY) paintIcon();
        },
        { signal },
      );
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => paintIcon(), { signal });
      // bb's own settings write the same key without a storage event, so also
      // watch the class the CSS keys off: every real appearance change, from
      // wherever it came, ends up there.
      const rootObserver = new MutationObserver(() => paintIcon());
      rootObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });

      const buttonFrom = (target: EventTarget | null): HTMLElement | null =>
        target instanceof Element
          ? (target.closest(BUTTON_SELECTOR) as HTMLElement | null)
          : null;

      const cancelHold = () => {
        if (holdTimer !== null) {
          window.clearTimeout(holdTimer);
          holdTimer = null;
        }
      };

      const cancelHover = () => {
        if (hoverTimer !== null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
      };

      document.addEventListener(
        "pointerdown",
        (event) => {
          const button = buttonFrom(event.target);
          if (!button || event.button !== 0) return;
          cancelHover();
          // Pressing the button is an explicit choice: no menu until the cursor
          // has left and come back.
          hoverBlocked = true;
          if (menu.isOpen) {
            const wasHover = menu.openedByHover;
            menu.close();
            // The hover menu opened by itself, so let the click do its usual
            // job — flip light/dark. A held-open menu swallows it.
            suppressClick = !wasHover;
            return;
          }
          cancelHold();
          holdTimer = window.setTimeout(() => {
            holdTimer = null;
            suppressClick = true;
            void menu.open(button);
          }, HOLD_MS);
        },
        { capture: true, signal },
      );

      for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
        document.addEventListener(type, cancelHold, {
          capture: true,
          signal,
        });
      }

      // Resting the cursor on the button opens the menu. Mouse only: a touch
      // "hover" is just the start of a tap, and that path is the hold gesture.
      document.addEventListener(
        "pointerover",
        (event) => {
          if (event.pointerType !== "mouse") return;
          const button = buttonFrom(event.target);
          if (!button) return;
          sync();
          if (hoverBlocked || menu.isOpen || hoverTimer !== null) return;
          hoverTimer = window.setTimeout(() => {
            hoverTimer = null;
            void menu.open(button, true);
          }, HOVER_MS);
        },
        { capture: true, signal },
      );

      document.addEventListener(
        "pointerout",
        (event) => {
          const button = buttonFrom(event.target);
          if (!button) return;
          // Moving between the button's own children is not a departure.
          const to = event.relatedTarget;
          if (to instanceof Node && button.contains(to)) return;
          cancelHover();
          hoverBlocked = false;
        },
        { capture: true, signal },
      );

      // The hold already opened the menu — swallow the host's click, otherwise
      // it flips the appearance on top of that.
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

      // Right-click opens the same menu, the way desktop users expect.
      document.addEventListener(
        "contextmenu",
        (event) => {
          const button = buttonFrom(event.target);
          if (!button) return;
          event.preventDefault();
          cancelHold();
          void menu.open(button);
        },
        { capture: true, signal },
      );

      return () => {
        cancelHold();
        cancelHover();
        if (findTimer !== null) window.clearTimeout(findTimer);
        footerObserver.disconnect();
        rootObserver.disconnect();
        menu.close();
      };
    },
  });
});
