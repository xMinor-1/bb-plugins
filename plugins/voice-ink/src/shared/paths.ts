// Constants the panel and the server share. This module imports nothing: the
// panel's bundle must not pull in contract.ts, whose `@get-bb/plugin-sdk`
// import exists only on the server side and breaks a git install's build.

/** The nav panel's route segment: /plugins/voice-ink/history/<entry id>. */
export const PANEL_PATH = "history";

/** Where the panel fetches audio bytes; the server streams them from the host. */
export const HISTORY_AUDIO_ROUTE = "/history/audio";
export const HISTORY_AUDIO_URL = `/api/v1/plugins/voice-ink/http${HISTORY_AUDIO_ROUTE}`;
