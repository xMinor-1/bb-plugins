// What a draft card does with a version of the draft that has just arrived —
// from its own load, a realtime nudge or the list it sits in. While a dialog
// is open, the card keeps showing the version the person is deciding on: a
// load cannot change it, even one that started before the dialog opened. A
// different version closes the dialog and is shown with a note, so nobody
// confirms one text and sends another.
import type { Draft } from "../../contract";

export type Arrived =
  | { action: "show"; draft: Draft | null }
  | { action: "keep" }
  | { action: "reopen"; draft: Draft | null; why: "changed" | "gone" };

/**
 * @param shown  the version on screen now
 * @param dialogOpen  whether a send or discard dialog is open at the moment the version arrived
 * @param latest  the version that arrived; null when the draft is no longer waiting
 */
export function arrived(shown: Draft | null | undefined, dialogOpen: boolean, latest: Draft | null): Arrived {
  if (!dialogOpen) return { action: "show", draft: latest };
  if (shown && latest && latest.revision === shown.revision) return { action: "keep" };
  return { action: "reopen", draft: latest, why: latest ? "changed" : "gone" };
}
