// bb-plugin-context-compact — the context ring under the composer becomes a
// compact button.
//
// BB draws that ring as a plain button labelled "Context window 42% used" whose
// only behavior is a hover card with the token figures. A content script
// intercepts its click and asks the backend to compact the thread instead, so
// the gauge that tells you the context is full is also the control that empties
// it — no typing `/compact`.
//
// The click has to know WHICH thread it belongs to, and BB puts no thread id in
// the composer's DOM. A composer customization supplies it: an action component
// renders one hidden marker per composer, carrying the scope's thread id, and
// the script reads the marker inside the clicked pane. Without a marker (a
// compact layout drops plugin actions) it falls back to the thread id in the
// URL, which is right whenever a single thread fills the window.
//
// Everything degrades quietly. A ring the selector no longer matches keeps its
// stock hover card, and a refused compaction — BB only compacts an idle or
// errored thread — surfaces as a toast rather than a silent no-op.
import { definePluginApp, useComposerView } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "context-compact";

/** BB's context ring: a button whose accessible name starts with this phrase. */
const RING_SELECTOR = 'button[aria-label^="Context window"]';

/** One thread's pane in a split layout; the whole window when there is no split. */
const PANE_SELECTOR = "[data-thread-window]";

/** Attribute the hidden composer marker carries its thread id in. */
const THREAD_ATTRIBUTE = "data-context-compact-thread";

const THREAD_ID_IN_PATH = /\/threads\/([A-Za-z0-9_-]+)/;

/**
 * A composer action that renders nothing visible — it exists to publish the
 * composer's thread id into the DOM, where the content script can read it.
 */
function ThreadMarker() {
  const { scope } = useComposerView();
  if (scope.kind !== "thread") return null;
  return <span hidden {...{ [THREAD_ATTRIBUTE]: scope.threadId }} />;
}

/** The thread the clicked ring belongs to: its own pane first, the route second. */
function resolveThreadId(ring: Element): string | null {
  const pane = ring.closest(PANE_SELECTOR) ?? document;
  const marker = pane.querySelector(`[${THREAD_ATTRIBUTE}]`);
  const marked = marker?.getAttribute(THREAD_ATTRIBUTE);
  if (marked) return marked;
  return THREAD_ID_IN_PATH.exec(window.location.pathname)?.[1] ?? null;
}

async function requestCompact(threadId: string): Promise<void> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  const envelope = await response.json().catch(() => null);
  if (!envelope?.ok) {
    throw new Error(envelope?.error?.message ?? `HTTP ${response.status}`);
  }
}

export default definePluginApp((app) => {
  // Thread composers only: a new-thread or side-chat composer has no context
  // ring to click.
  app.composer.customize({
    id: "thread-marker",
    scopes: ["thread"],
    actions: [{ id: "marker", component: ThreadMarker }],
  });

  app.contentScripts.register({
    id: "ring-click",
    mount({ signal }) {
      // One compaction per thread at a time: the ring stays clickable while the
      // request is in flight, and a double click must not send two.
      const inFlight = new Set<string>();

      const onClick = (event: MouseEvent) => {
        if (event.button !== 0 || event.defaultPrevented) return;
        const target = event.target instanceof Element ? event.target : null;
        const ring = target?.closest(RING_SELECTOR);
        if (!ring) return;

        // Capture phase, so the host's hover card never sees the click and the
        // ring does not pin its popover on the way to compacting.
        event.preventDefault();
        event.stopPropagation();

        const threadId = resolveThreadId(ring);
        if (!threadId) {
          toast.error("No thread to compact here.");
          return;
        }
        if (inFlight.has(threadId)) return;
        inFlight.add(threadId);

        requestCompact(threadId).then(
          () => {
            inFlight.delete(threadId);
            toast.success("Compacting context…");
          },
          (cause: unknown) => {
            inFlight.delete(threadId);
            const detail = cause instanceof Error ? cause.message : String(cause);
            toast.error(`Could not compact: ${detail}`);
          },
        );
      };

      document.addEventListener("click", onClick, { capture: true, signal });
      return () =>
        document.removeEventListener("click", onClick, { capture: true });
    },
  });
});
