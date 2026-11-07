// What every view of the board needs, computed once per render of the page.
import { createContext, useContext } from "react";
import type { Lang } from "@/lib/i18n";
import { splitPrefix, type Issue } from "../shared/model";
import type { Display } from "../shared/prefs";
import { prefixId, type Template } from "../shared/templates";
import type { BoardView, ConfigView, StatusView } from "../server/rpc-contract";
import type { Messages } from "./messages";

export interface ViewData {
  t: Messages;
  lang: Lang;
  locale: string;
  today: string;
  config: ConfigView;
  board: BoardView;
  display: Display;
  statuses: StatusView[];
  colors: Map<string, string>;
  byKey: Map<string, Issue>;
  children: Map<string, Issue[]>;
  templates: Template[];
  /** Templates whose tiles a story card shows. */
  parts: Template[];
  selection: ReadonlySet<string>;
  flash: ReadonlySet<string>;
  openKey: string | null;
  open(key: string): void;
  pick(key: string): void;
  statusName(key: string): string;
  priorityName(key: string | null): string | undefined;
  personName(id: string | null): string;
  /** Drag a card to another column to change its status. */
  drop(key: string, status: string): void;
  addFromTemplates(parentKey: string): void;
}

export const ViewContext = createContext<ViewData | null>(null);

export function useView(): ViewData {
  const view = useContext(ViewContext);
  if (!view) throw new Error("The board view is not ready");
  return view;
}

export function childrenOf(issues: readonly Issue[]): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.parent) continue;
    const list = out.get(issue.parent) ?? [];
    list.push(issue);
    out.set(issue.parent, list);
  }
  return out;
}

/** A story's parts by template: which exist (and in what status) and which are missing. */
export function composition(story: Issue, view: Pick<ViewData, "children" | "parts">) {
  const kids = view.children.get(story.key) ?? [];
  const byPrefix = new Map<string, Issue>();
  for (const kid of kids) {
    const { prefix } = splitPrefix(kid.summary);
    if (prefix && !byPrefix.has(prefix.toLowerCase())) byPrefix.set(prefix.toLowerCase(), kid);
  }
  const parts = view.parts.map((template) => ({ template, issue: byPrefix.get(prefixId(template).toLowerCase()) ?? null }));
  const used = new Set(parts.map((part) => part.issue?.key).filter((key): key is string => Boolean(key)));
  const extra = kids.filter((kid) => !used.has(kid.key));
  const done = kids.filter((kid) => kid.category === "done").length;
  return { parts, extra, done, total: kids.length, missing: parts.filter((part) => !part.issue).map((part) => part.template) };
}
