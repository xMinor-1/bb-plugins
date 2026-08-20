// Theme button in the sidebar footer.
//   short click        — next palette
//   hold / right-click — menu: light / dark / system + the palette list
//   hover and wait     — the same menu, without pressing anything (mouse only)
//
// sidebarFooterAction is rendered by the host, so the long-press is attached by
// a content script to the host's own button markup (stable data-testid), and
// the menu is drawn as plain DOM on top of the app.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "theme-toggle";
const ACTION_ID = "cycle-theme";
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
  // still cycle the palette; a held-open one swallows that click instead.
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
    title: "Theme: click for the next palette, hold to choose",
    icon: "Palette",
    run: async () => {
      try {
        const state = await callRpc("cycle");
        const name =
          state.themes.find((t) => t.id === state.activeId)?.name ??
          state.activeId;
        toast.success(`Palette: ${name}`);
      } catch (error) {
        toast.error(`Could not change the palette: ${String(error)}`);
      }
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
            // job — cycle the palette. A held-open menu swallows it.
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
          if (!button || hoverBlocked || menu.isOpen || hoverTimer !== null) {
            return;
          }
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
      // it cycles the palette on top of that.
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
        menu.close();
      };
    },
  });
});
