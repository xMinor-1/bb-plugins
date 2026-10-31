// Limits the host, the server and the panel share. No imports: the panel's
// bundle may load this file, and the server SDK is not available there.

/** Files over this stay in Outlook: the panel downloads attachments through bb as base64. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The longest stretch of calendar read at once, in days. */
export const CALENDAR_MAX_DAYS = 62;
/** Events read at once; a busier stretch is cut and says so. */
export const CALENDAR_MAX_EVENTS = 500;
