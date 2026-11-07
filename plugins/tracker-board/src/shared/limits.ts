// Limits shared by the server, the host entry and the panel. No imports here:
// the panel bundle must not pull the plugin SDK in through this module.
export const LIMITS = {
  apiKey: 4000,
  queryValue: 8000,
  requestBody: 200_000,
  /** One response from the tracker; a board page of a few hundred issues fits. */
  responseBytes: 4 * 1024 * 1024,
  /** Issues one board shows. A queue walk stops here and says so. */
  boardIssues: 3000,
  /** Changes one confirmation may hold. */
  changes: 200,
  /** Keys one agent read may ask for. */
  readKeys: 100,
  summary: 500,
  description: 100_000,
  comment: 20_000,
  label: 200,
  labels: 50,
  templates: 100,
  people: 200,
  recent: 12,
  /** Boards one person keeps under "My boards", the build's included. */
  boards: 30,
} as const;
