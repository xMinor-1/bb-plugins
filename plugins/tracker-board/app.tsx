// bb-plugin-tracker-board — frontend.
//
// A navigation page with the board, its controls in bb's title bar, a task tab
// for bb's side panel, the form that asks the person to confirm an agent's
// changes above the chat's composer, and the card with Undo for changes an agent
// applied at once.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { messagesNow } from "@/lib/i18n";
import { ChangesDirective } from "./src/app/ChangesCard";
import { ConfirmForm } from "./src/app/ConfirmForm";
import { IssueTab } from "./src/app/IssueTab";
import { messages } from "./src/app/messages";
import { BoardPage, PageHeader } from "./src/app/Page";
import { ISSUE_TAB_ID, PANEL_ID } from "./src/app/requests";
import "./app.css";

const ICON = "tracker-board.board";
const CONFIRM_RENDERER = "confirm-changes";

function BoardGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="11" rx="1.5" />
      <rect x="16.5" y="4" width="4" height="7" rx="1.5" />
    </svg>
  );
}

export default definePluginApp((app) => {
  // Titles registered at load follow the language picked before the page loaded.
  const t = messagesNow(messages);
  app.experimental_icons.register({ name: ICON, component: BoardGlyph });

  app.slots.navPanel({
    id: PANEL_ID,
    title: t.panelTitle,
    icon: ICON,
    path: PANEL_ID,
    component: BoardPage,
    headerContent: PageHeader,
  });

  app.slots.experimental_tab({
    id: ISSUE_TAB_ID,
    title: t.panelTitle,
    icon: ICON,
    context: { kind: "nav-panel", panelId: PANEL_ID },
    availability: "action",
    layout: "flush",
    component: IssueTab,
  });

  app.slots.pendingInteraction({ id: CONFIRM_RENDERER, component: ConfirmForm });
  app.slots.messageDirective({ id: "tracker-changes", component: ChangesDirective });
});
