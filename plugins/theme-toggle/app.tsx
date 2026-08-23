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

// The button wears the switch from icon.svg, and it slides: knob left with a
// crescent while the dark appearance is on, sun and knob right while it is
// light. BB renders branding.icon as a CSS mask over a span inside its own
// button, so swapping that one mask keeps the host's chrome untouched.
// Keep the night face here identical to icon.svg — that file is the still
// version bb shows in the plugin catalog.
//
// The switch body is one opaque capsule and everything on it is punched out
// through an SVG mask: a mask image reads alpha, so a lighter fill would add
// to the shape instead of cutting into it. The viewBox hugs the drawing, since
// bb scales the whole box down into 16 px of chrome.
const ICON_MASK_ID = "bb-theme-toggle-cut";
const ICON_VIEW_BOX = "0 0 24.4 16.4";

const ICON_KNOB_LEFT = '<circle cx="8.2" cy="8.2" r="4.8" fill="#000"/>';
const ICON_KNOB_RIGHT = '<circle cx="16.2" cy="8.2" r="4.8" fill="#000"/>';
const ICON_MOON =
  '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="#000" transform="translate(13.32 3.88) scale(0.36)"/>' +
  '<path d="M21.9 4.85Q22.15 5.45 22.75 5.7 22.15 5.95 21.9 6.55 21.65 5.95 21.05 5.7 21.65 5.45 21.9 4.85Z" fill="#000"/>';
const ICON_SUN =
  '<circle cx="5.9" cy="8.2" r="2.15" fill="#000"/>' +
  '<g stroke="#000" stroke-width="1.15" stroke-linecap="round">' +
  '<path d="M5.9 5.3V4.65M5.9 11.1v.65M3 8.2h-.65M8.8 8.2h.65M3.85 6.15l-.46-.46M7.95 10.25l.46.46M7.95 6.15l.46-.46M3.85 10.25l-.46.46"/>' +
  "</g>";

function iconUrl(holes: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ICON_VIEW_BOX}">` +
    `<defs><mask id="${ICON_MASK_ID}" maskUnits="userSpaceOnUse" x="0" y="0" width="24.4" height="16.4">` +
    '<rect width="24.4" height="16.4" fill="#fff"/>' +
    holes +
    "</mask></defs>" +
    `<rect width="24.4" height="16.4" rx="8.2" fill="#000" mask="url(#${ICON_MASK_ID})"/>` +
    "</svg>";
  // encodeURIComponent leaves brackets alone, and an unescaped one inside a
  // data URI ends the CSS url() token early — the declaration is then dropped
  // and the button silently keeps the face it had.
  const encoded = encodeURIComponent(svg)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `url("data:image/svg+xml,${encoded}")`;
}

const ICON_NIGHT = iconUrl(ICON_KNOB_LEFT + ICON_MOON);
const ICON_DAY = iconUrl(ICON_SUN + ICON_KNOB_RIGHT);

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
