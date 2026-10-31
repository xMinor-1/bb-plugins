// bb-plugin-exchange-mail — frontend entry: the Mail page in the left sidebar,
// the draft card agents put into their replies, and the card where the person
// chooses among people with similar names.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { messagesNow } from "./lib/i18n";
import { DraftDirective } from "./src/app/DraftDirective";
import { MailPage } from "./src/app/MailPage";
import { PersonChoice } from "./src/app/PersonChoice";
import { messages } from "./src/messages";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    // Registered once: a language switch shows here after the page reloads.
    title: messagesNow(messages).navTitle,
    icon: "Mail",
    path: "mail",
    component: MailPage,
  });
  app.slots.messageDirective({ id: "mail-draft", component: DraftDirective });
  // The id is PERSON_CHOICE in server.ts; the panel may not import values from there.
  app.slots.pendingInteraction({ id: "mail-person-choice", component: PersonChoice });
});
