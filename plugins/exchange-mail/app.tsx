// bb-plugin-exchange-mail — frontend entry: one Mail item in the left sidebar
// (mail and, behind a switch at the top, the calendar),
// the draft and meeting cards agents put into their replies, and the card where
// the person chooses among people with similar names.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { messagesNow } from "./lib/i18n";
import { DraftDirective } from "./src/app/DraftDirective";
import { MAIL_PATH, MailPage } from "./src/app/MailPage";
import { MeetingDirective } from "./src/app/MeetingDirective";
import { PersonChoice } from "./src/app/PersonChoice";
import { messages } from "./src/messages";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    // Registered once: a language switch shows here after the page reloads.
    title: messagesNow(messages).navTitle,
    icon: "Mail",
    // The calendar is the subPath "calendar" of this panel: /plugins/exchange-mail/mail/calendar.
    path: MAIL_PATH,
    component: MailPage,
  });
  app.slots.messageDirective({ id: "mail-draft", component: DraftDirective });
  app.slots.messageDirective({ id: "meeting-proposal", component: MeetingDirective });
  // The id is PERSON_CHOICE in server.ts; the panel may not import values from there.
  app.slots.pendingInteraction({ id: "mail-person-choice", component: PersonChoice });
});
