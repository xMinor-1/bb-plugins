// lib/composer-bus.ts — the only way the host-rendered "+" row can reach a
// component of ours.
//
// A `plusMenu` item is drawn by bb, not by this plugin: `run({ composer, view })`
// is a callback, not a React tree, so it has nowhere to mount a dialog. The
// two surfaces `composer.customize` does mount are `actions` and `banners`,
// and only one of them is usable here:
//
//   * `actions` sit in the composer's button row and the host skips them
//     entirely in the compact layout — the picker would vanish on exactly the
//     narrow surfaces where a file browser helps most;
//   * `banners` are mounted for every composer, and `chrome: "bare"` renders
//     the component with no wrapper at all, so a picker that is not open adds
//     no DOM and no gap.
//
// So the banner is the mount point and this module carries the "open" request
// to it. Banners are mounted once per composer on screen (a thread and its
// side chat can both be live), so a request names the composer scope it came
// from and only the banner in that scope answers.
import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";

/**
 * Stable identity for one composer, mirroring the host's own scope key.
 *
 * Every field matters: two side chats under one thread differ only by `tabId`,
 * and a queued message being edited is a different draft from the thread's.
 */
export function composerScopeKey(scope: PluginComposerScope): string {
  switch (scope.kind) {
    case "thread":
      return `thread:${scope.threadId}`;
    case "queued-message":
      return `queued-message:${scope.threadId}:${scope.queuedMessageId}`;
    case "side-chat":
      return [
        "side-chat",
        scope.projectId,
        scope.parentThreadId,
        scope.tabId,
        scope.childThreadId ?? "",
      ].join(":");
    case "new-thread":
      return `new-thread:${scope.projectId ?? ""}`;
  }
}

type Listener = (scopeKey: string) => void;

const listeners = new Set<Listener>();

/** Called from the "+" row: "open your picker, whoever owns this composer". */
export function requestFilePick(scopeKey: string): void {
  // Copied first: a listener that unsubscribes while the set is being walked
  // would otherwise skip the next one.
  for (const listener of [...listeners]) listener(scopeKey);
}

export function subscribeFilePickRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
