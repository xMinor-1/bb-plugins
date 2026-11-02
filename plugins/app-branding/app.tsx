import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { watchBranding } from "./src/branding";

export default definePluginApp((app) => {
  // A content script and not an overlay: bb's onboarding screen, which carries its logo, replaces the app shell,
  // so overlays only appear after it. A content script has no settings hook, so it asks this plugin's server.
  app.contentScripts.register({
    id: "branding",
    mount({ pluginId }) {
      return watchBranding(document, async () => {
        const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/branding`);
        if (!response.ok) throw new Error(`Branding settings: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
      });
    },
  });
});
