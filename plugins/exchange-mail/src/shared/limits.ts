// Limits the host, the server and the panel share. No imports: the panel's
// bundle may load this file, and the server SDK is not available there.

/** Files over this stay in Outlook: the panel downloads attachments through bb as base64. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The longest stretch of calendar read at once, in days. */
export const CALENDAR_MAX_DAYS = 62;
/** Events read at once; a busier stretch is cut and says so. */
export const CALENDAR_MAX_EVENTS = 500;
/** Free time is looked for in at most this many days at once. */
export const FREE_TIME_MAX_DAYS = 31;
/**
 * Longest subject, place and organizer name kept of an event, and of its list
 * of invitees. Exchange keeps subjects and places under 256 characters; an
 * invitation from outside may carry anything, so the host cuts it when reading.
 */
export const CALENDAR_TEXT_MAX = 1000;
export const CALENDAR_ATTENDEES_MAX = 4000;
