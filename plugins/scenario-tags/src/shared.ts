// Names shared by server.ts and app.tsx. No imports: the frontend bundle must
// not pull the SDK in through this module.

/** Realtime channel: the person's pinned tags changed. */
export const PINS_CHANGED = "pins-changed";
/** Most tags a person can pin. */
export const MAX_PINS = 50;
