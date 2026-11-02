import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { applyBranding, readBranding } from "./src/branding";

// Renders nothing: it exists to read the settings, which a content script cannot do,
// and it lives as long as the app window, on every route.
function Branding() {
  const { values } = useSettings();
  const { appName, logoSvg } = readBranding(values ?? {});
  useEffect(() => applyBranding(document, { appName, logoSvg }), [appName, logoSvg]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "branding", component: Branding });
});
