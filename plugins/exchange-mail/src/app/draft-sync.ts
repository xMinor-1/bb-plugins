// What a draft card does when the draft changes while a confirmation dialog is
// open. The dialog must keep showing the version the person is deciding on; a
// new version closes the dialog and is shown on its own, so nobody confirms
// one text and sends another.
import type { Draft } from "../../contract";

export type WhileConfirming = { action: "keep" } | { action: "reopen"; why: "changed" | "gone" };

export function whileConfirming(shown: Draft | null, latest: Draft | null): WhileConfirming {
  if (shown && latest && latest.revision === shown.revision) return { action: "keep" };
  return { action: "reopen", why: latest ? "changed" : "gone" };
}
