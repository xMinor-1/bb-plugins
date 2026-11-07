// The sidebar item replaces a button that was always on screen, so the plugin shows it once after install or update.
// bb shows a new item to everyone who never changed the sidebar and puts it under More for people who did: for them
// the item is added to their visible list. The mark keeps it to once, so hiding it later sticks.
export const PANEL_ID = "report";
export const PANEL_TITLE = "Bug report";
export const REVEALED_KEY = "sidebar-item-revealed";
const VISIBLE_KEY = "sidebar.visiblePluginPanels";

type Entry = { revision: number; value: unknown };
export type RevealDeps = {
  itemId: string;
  wasRevealed: () => Promise<boolean>;
  markRevealed: () => Promise<void>;
  readVisible: () => Promise<Entry>;
  writeVisible: (value: string[], expectedRevision: number) => Promise<void>;
};

/** The visible list with the item, or null when the item is already shown (or the person never changed the sidebar). */
export function withItem(visible: unknown, itemId: string): string[] | null {
  if (!Array.isArray(visible)) return null;
  const keys = visible.filter((key): key is string => typeof key === "string");
  return keys.includes(itemId) ? null : [...keys, itemId];
}

/** Returns what it did: "shown", "already-visible" or "done-before". A failure throws and leaves the mark unset. */
export async function revealOnce(deps: RevealDeps): Promise<"shown" | "already-visible" | "done-before"> {
  if (await deps.wasRevealed()) return "done-before";
  const entry = await deps.readVisible();
  const next = withItem(entry.value, deps.itemId);
  if (next) await deps.writeVisible(next, entry.revision);
  await deps.markRevealed();
  return next ? "shown" : "already-visible";
}
