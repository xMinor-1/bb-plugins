// bb-plugin-express-messenger — frontend entry: the Messenger page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { messagesNow } from "./lib/i18n";
import { MessengerPage } from "./src/app/MessengerPage";
import { messages } from "./src/app/messages";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "messenger",
    // Registered once: a language switch shows here after the page reloads.
    title: messagesNow(messages).navTitle,
    icon: "MessageSquare",
    path: "messenger",
    component: MessengerPage,
  });
});
