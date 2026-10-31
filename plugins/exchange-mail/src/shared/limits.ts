// Limits the host, the server and the panel share. No imports: the panel's
// bundle may load this file, and the server SDK is not available there.

/** Files over this stay in Outlook: the panel downloads attachments through bb as base64. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
