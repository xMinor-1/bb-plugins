// bb-plugin-mcp-catalog — frontend entry: the MCP page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { messagesNow } from "./lib/i18n";
import { McpPage } from "./src/app/McpPage";
import { messages } from "./src/messages";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mcp",
    // Registered once: a language switch shows here after the page reloads.
    title: messagesNow(messages).navTitle,
    icon: "Plug02",
    path: "mcp",
    component: McpPage,
  });
});
