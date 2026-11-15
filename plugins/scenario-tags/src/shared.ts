// Names shared by server.ts and app.tsx. Only type imports: the frontend
// bundle must not pull the SDK in through this module.
import type { Scenario } from "./catalog";

/** Realtime channel: the person's pinned tags changed. */
export const PINS_CHANGED = "pins-changed";
/** Realtime channel: the person's own scenarios changed. */
export const OWN_CHANGED = "own-changed";
/** Realtime channel: the person hid or showed a scenario again, or saw new ones. */
export const CURATION_CHANGED = "curation-changed";
/** Most tags a person can pin. */
export const MAX_PINS = 50;
/** The `pendingInteraction` renderer that previews a scenario before `scenario_save` stores it. */
export const PREVIEW_RENDERER = "scenario-preview";

/** What the preview shows: the scenario and the label of the own scenario it replaces. */
export type PreviewPayload = { scenario: Scenario; replaces: string | null };
/** What the preview sends back. */
export type PreviewDecision = { save: boolean };
