// Setting schemas shared by the server entry (validation in bb's settings form)
// and the host entry (the same checks on what arrives in a call).
import { z } from "zod";

// Copied from plugins/fleet-kit/src/shared/settings.ts (commit ccc161e): the
// OpenCode directory is resolved exactly as Fleet Kit resolves it, so both
// plugins write the same opencode.json.
export const opencodeConfigDirSchema = z.string().max(4000).refine((value) =>
  value === "" || (!/[\x00-\x1f\x7f]/.test(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)),
  "Use an absolute directory path, or leave empty to use the ACP environment default.",
);

/** An http(s) address, or empty. */
export const webAddressSchema = z.string().max(2000).refine(
  (value) => value.trim() === "" || /^https?:\/\/[^\s]+$/i.test(value.trim()),
  "Use an http:// or https:// address, or leave empty.",
);

export const TIMEOUT_LIMITS = { min: 1, max: 600 } as const;
export const INTERVAL_LIMITS = { min: 2, max: 1440 } as const;

/** Development only, in bb's environment: lets servers and catalogs on plain http (a local stub) through. */
export const DEV_HTTP_FLAG = "BB_MCP_CATALOG_ALLOW_HTTP";
