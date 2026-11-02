// Failures the person can act on carry a code, so the panel says them in its own language.
// Agents and logs get the English text alone; the panel gets the same text behind a tag,
// `[express:<code>]`, and shows its translation (src/app/errors.ts). A failure without a code
// reaches the panel in English, as it is.

/** Every one has a translation in src/app/errors.ts; a test holds them in step. */
export const PANEL_CODES = ["sign-in", "unreachable", "no-browser", "busy", "not-confirmed", "not-in-directory"] as const;
export type PanelCode = (typeof PANEL_CODES)[number];

const TAG = /^\[express:([a-z-]+)\]\s*/;

export function tagged(code: PanelCode, text: string): string {
  return `[express:${code}] ${text}`;
}

/** The text for an agent or a log. */
export function untagged(text: string): string {
  return text.replace(TAG, "");
}

export function codeOf(text: string): string | null {
  return TAG.exec(text)?.[1] ?? null;
}
