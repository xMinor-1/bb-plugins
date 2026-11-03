import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { watchButton } from "./src/button";

export default definePluginApp((app) => {
  // A content script and not an overlay: bb's onboarding screen replaces the app shell, so overlays only appear after
  // it. A content script has no settings hook, so it asks this plugin's server.
  app.contentScripts.register({
    id: "button",
    mount({ pluginId }) {
      return watchButton(document, async () => {
        const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/config`);
        if (!response.ok) throw new Error(`Bug report button settings: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
      });
    },
  });
});
