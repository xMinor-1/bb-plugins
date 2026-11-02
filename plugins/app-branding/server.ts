// bb-plugin-app-branding — server entry. It only declares the settings; the page does the work (app.tsx).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_LOGO_LENGTH, isUsableLogo } from "./src/branding";

export default function appBranding(bb: BbPluginApi) {
  bb.settings.define({
    appName: {
      type: "string",
      label: "App name",
      description: "Replaces the default bb page title. Empty keeps it.",
      experimental_schema: z.string().max(80),
      default: "",
    },
    logoSvg: {
      type: "string",
      label: "Logo (SVG)",
      description: `SVG source that replaces the bb logo and favicon, up to ${MAX_LOGO_LENGTH} characters. It is drawn as an image, so scripts in it do not run. Empty keeps the bb logo.`,
      experimental_multiline: true,
      experimental_schema: z.string().refine((value) => value.trim() === "" || isUsableLogo(value), "Logo must be SVG source"),
      default: "",
    },
  });
}
