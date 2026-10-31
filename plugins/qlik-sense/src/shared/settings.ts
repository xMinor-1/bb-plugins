import { z } from "zod";

export const allowedProvidersSchema = z.string().max(2000).refine(
  (value) => value.trim() === "" || value.trim().split(/[\s,]+/).every((id) => /^[A-Za-z0-9_-]+$/.test(id)),
  "Use provider IDs separated by commas or spaces, without wildcards.",
);

export const urlSettingSchema = z.string().max(2000).refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Use an HTTPS base URL without credentials, query parameters, or a fragment.");

export const opencodeConfigDirSchema = z.string().max(4000).refine((value) =>
  value === "" || (!/[\x00-\x1f\x7f]/.test(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)),
  "Use an absolute directory path, or leave empty to use the ACP environment default.",
);

export const connectionSettings = {
  url: {
    type: "string" as const,
    label: "Qlik Sense URL",
    default: "",
    experimental_schema: urlSettingSchema,
  },
  allowedProviders: {
    type: "string" as const,
    label: "Allowed OpenCode providers (empty disables the provider restriction)",
    default: "",
    experimental_schema: allowedProvidersSchema,
  },
  opencodeConfigDir: {
    type: "string" as const,
    label: "OpenCode configuration directory (empty uses the ACP default)",
    default: "",
    experimental_schema: opencodeConfigDirSchema,
  },
};

export function parseAllowedProviders(value: string): string[] {
  return [...new Set(allowedProvidersSchema.parse(value).trim().split(/[\s,]+/).filter(Boolean))];
}
