// Copied from plugins/qlik-sense/src/shared/settings.ts (commit c0399a0). Keep both copies in sync.
// Only the schemas and the parser are shared; Qlik's own setting descriptors stay in qlik-sense.
import { z } from "zod";
export const allowedProvidersSchema = z.string().max(2000).refine(
  (value) => value.trim() === "" || value.trim().split(/[\s,]+/).every((id) => /^[A-Za-z0-9_-]+$/.test(id)),
  "Use provider IDs separated by commas or spaces, without wildcards.",
);
export const opencodeConfigDirSchema = z.string().max(4000).refine((value) =>
  value === "" || (!/[\x00-\x1f\x7f]/.test(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)),
  "Use an absolute directory path, or leave empty to use the ACP environment default.",
);
export function parseAllowedProviders(value: string): string[] {
  return [...new Set(allowedProvidersSchema.parse(value).trim().split(/[\s,]+/).filter(Boolean))];
}
