// bb-plugin-sticker-note — frontend.
//
// A navigation page with the board, a badge with today's count, the glass
// sticker icon, and a sidebar footer button that opens the board. The footer
// button cannot carry a badge through the SDK, so a content script adds one.
import { useEffect } from "react";
import { definePluginApp, useBbNavigate, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";

import { getLang, useMessages } from "@/lib/i18n";

import { BoardHeader, BoardPage } from "./components/Board";
import { StickerMark } from "./components/icons";
import { useCards } from "./hooks/useCards";
import { useNow } from "./hooks/useNow";
import { todayStore } from "./hooks/stores";
import { todayStats } from "./src/board";
import { messages } from "./src/messages";
import "./app.css";

const PANEL_PATH = "board";
const ICON = "sticker-note.mark";
const FOOTER_ID = "open";
const OPEN_EVENT = "sticker-note:open";

/** Today's open cards: the navigation badge, and the feed for the footer badge. */
function useTodayBadge(): ExperimentalBadge | null {
  const m = useMessages(messages);
  const { cards } = useCards();
  const now = useNow();
  const stats = cards ? todayStats(cards, now) : { count: 0, overdue: 0 };
  useEffect(() => {
    todayStore.set(stats);
  }, [stats.count, stats.overdue]);
  if (!stats.count) return null;
  return {
    count: stats.count,
    tone: stats.overdue ? "critical" : "neutral",
    label: m.todayBadge(stats.count, stats.overdue),
  };
}

/** Navigation needs a hook; the footer button's handler reaches it through an event. */
function OpenBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    const open = () => navigate.toPluginPanel(PANEL_PATH);
    document.addEventListener(OPEN_EVENT, open);
    return () => document.removeEventListener(OPEN_EVENT, open);
  }, [navigate]);
  return null;
}

const BADGE_CSS = `
.sn-footer-badge{position:absolute;top:-3px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;
  display:grid;place-items:center;font:700 9.5px/1 system-ui,sans-serif;background:#e9ac17;color:#1d1d1d;
  box-shadow:0 0 0 2px var(--sidebar,var(--background));pointer-events:none;font-variant-numeric:tabular-nums}
.sn-footer-badge.late{background:#d63c3c;color:#fff}
`;

export default definePluginApp((app) => {
  app.experimental_icons.register({
    name: ICON,
    component: ({ className }) => <StickerMark className={className} />,
  });

  app.slots.navPanel({
    id: PANEL_PATH,
    title: "Sticker Note",
    icon: ICON,
    path: PANEL_PATH,
    component: BoardPage,
    headerContent: BoardHeader,
    experimental_useBadge: useTodayBadge,
  });

  app.slots.experimental_appOverlay({ id: "open-bridge", component: OpenBridge });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: FOOTER_ID,
    label: getLang() === "ru" ? messages.ru.openBoard : messages.en.openBoard,
    icon: ICON,
    onActivate: () => {
      document.dispatchEvent(new CustomEvent(OPEN_EVENT));
    },
  });

  // Today's count on the footer button. Only an own node is added to the host
  // button; host nodes are never moved, and the inline style is restored.
  app.contentScripts.register({
    id: "footer-badge",
    mount({ pluginId, signal }) {
      const style = document.createElement("style");
      style.textContent = BADGE_CSS;
      document.head.append(style);
      const badge = document.createElement("span");
      badge.className = "sn-footer-badge";
      badge.setAttribute("aria-hidden", "true");
      let button: HTMLElement | null = null;
      let restorePosition: string | null = null;

      const selector = [
        `[data-testid="plugin-sidebar-footer-item-${pluginId}-${FOOTER_ID}"]`,
        `[data-testid="plugin-sidebar-footer-action-${pluginId}-${FOOTER_ID}"]`,
      ].join(",");

      const detach = () => {
        badge.remove();
        if (button && restorePosition !== null) button.style.position = restorePosition;
        restorePosition = null;
        button = null;
      };

      const draw = () => {
        const { count, overdue } = todayStore.get();
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.classList.toggle("late", overdue > 0);
        badge.hidden = count === 0;
        badge.style.display = count === 0 ? "none" : "";
      };

      const attach = () => {
        const next = document.querySelector<HTMLElement>(selector);
        if (next === button && badge.parentNode === next) return;
        detach();
        if (!next) return;
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        next.append(badge);
        draw();
      };

      const observer = new MutationObserver(attach);
      observer.observe(document.body, { childList: true, subtree: true });
      const unsubscribe = todayStore.subscribe(draw);
      attach();
      signal.addEventListener("abort", () => observer.disconnect(), { once: true });

      return () => {
        observer.disconnect();
        unsubscribe();
        detach();
        style.remove();
      };
    },
  });
});
