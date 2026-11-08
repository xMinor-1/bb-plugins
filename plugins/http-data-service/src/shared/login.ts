// The login rule, shared by the host (which saves it) and the server (which refuses a bad
// one before asking any machine).

/** The host contract's limits for a login and a password. */
export const MAX_LOGIN = 200;
export const MAX_PASSWORD = 500;

/** A login with a colon cannot be sent over HTTP Basic (RFC 7617). */
export function checkLogin(user: string): string {
  const trimmed = user.trim();
  if (trimmed === "" || trimmed.includes(":") || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("The login must not be empty or contain a colon");
  return trimmed;
}
