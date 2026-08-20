// Кнопка темы в футере сайдбара.
//   короткий клик       — следующая палитра
//   удержание / ПКМ     — меню: светлая / тёмная / как в системе + список палитр
//
// sidebarFooterAction рисует сам хост, поэтому long-press вешается content
// script'ом на host-разметку кнопки (стабильный data-testid), а меню рисуется
// своим DOM поверх приложения.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "theme-toggle";
const ACTION_ID = "cycle-theme";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;
const HOLD_MS = 400;

// Режим оформления — клиентская настройка BB (jotai atomWithStorage, сырая
// строка). Ключ и значения совпадают с useTheme приложения.
const MODE_KEY = "bb.theme";
type Mode = "light" | "dark" | "system";
const MODES: Array<{ id: Mode; label: string }> = [
  { id: "light", label: "Светлая" },
  { id: "dark", label: "Тёмная" },
  { id: "system", label: "Как в системе" },
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
    /* приватный режим — обойдёмся классом ниже */
  }
  // BB читает ключ через atomWithStorage, который слушает событие storage.
  // Своя вкладка его не получает, поэтому шлём синтетическое — приложение
  // перерисуется штатно, а не только сменит класс.
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: MODE_KEY,
      oldValue: previous,
      newValue: mode,
      storageArea: localStorage,
    }),
  );
  // Подстраховка, если событие не дошло: класс `dark` — то, что читает CSS.
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

// --- меню -------------------------------------------------------------------

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

  get isOpen(): boolean {
    return this.panel !== null;
  }

  close = (): void => {
    for (const off of this.cleanup.splice(0)) off();
    this.panel?.remove();
    this.panel = null;
  };

  async open(anchor: HTMLElement): Promise<void> {
    this.close();
    const panel = document.createElement("div");
    panel.setAttribute("style", PANEL_STYLE);
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "Оформление");
    // Ставим за экран, пока не измерили высоту.
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

    const render = (state: ThemeState) => {
      if (this.panel !== panel) return;
      panel.replaceChildren();

      const modeLabel = document.createElement("div");
      modeLabel.textContent = "Оформление";
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
      paletteLabel.textContent = "Палитра";
      paletteLabel.setAttribute("style", LABEL_STYLE);
      panel.append(paletteLabel);

      for (const theme of state.themes) {
        panel.append(
          makeRow(theme.name, theme.id === state.activeId, () => {
            void callRpc("select", { themeId: theme.id })
              .then(render)
              .catch((error: unknown) =>
                toast.error(`Не удалось сменить палитру: ${String(error)}`),
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
      toast.error(`Не удалось прочитать темы: ${String(error)}`);
    }
  }
}

// --- регистрация ------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Тема: клик — следующая палитра, удержание — выбор",
    icon: "Palette",
    run: async () => {
      try {
        const state = await callRpc("cycle");
        const name =
          state.themes.find((t) => t.id === state.activeId)?.name ??
          state.activeId;
        toast.success(`Палитра: ${name}`);
      } catch (error) {
        toast.error(`Не удалось сменить палитру: ${String(error)}`);
      }
    },
  });

  app.contentScripts.register({
    id: "theme-hold-menu",
    mount({ signal }) {
      const menu = new ThemeMenu();
      let holdTimer: number | null = null;
      let suppressClick = false;

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

      document.addEventListener(
        "pointerdown",
        (event) => {
          const button = buttonFrom(event.target);
          if (!button || event.button !== 0) return;
          if (menu.isOpen) {
            menu.close();
            suppressClick = true;
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

      // Удержание уже открыло меню — гасим штатный клик хоста (иначе он ещё
      // и палитру переключит).
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

      // Правый клик — тот же выбор, привычный для десктопа.
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
        menu.close();
      };
    },
  });
});
