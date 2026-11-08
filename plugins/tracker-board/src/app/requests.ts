// Requests between the board page and the task tab, which render in separate trees.
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import { createStore } from "./store";

export const PANEL_ID = "board";
export const ISSUE_TAB_ID = "issue";

/** The task tab asks the page to open the templates dialog for this parent. */
export const templatesRequestStore = createStore<{ key: string; at: number } | null>(null);

/** Opens a task in bb's side panel, one tab per task. */
export function useOpenIssue(): (key: string) => void {
  const panel = experimental_useAppPanel();
  return useCallback(
    (key: string) => {
      panel.openTab({ tab: { id: ISSUE_TAB_ID, context: { kind: "nav-panel", panelId: PANEL_ID }, availability: "action" }, params: { key }, title: key });
    },
    [panel],
  );
}
