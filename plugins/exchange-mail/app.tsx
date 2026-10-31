// bb-plugin-exchange-mail — frontend entry: the Mail page in the left sidebar,
// and the draft card agents put into their replies.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DraftDirective } from "./src/app/DraftDirective";
import { MailPage } from "./src/app/MailPage";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: "Mail",
    icon: "Mail",
    path: "mail",
    component: MailPage,
  });
  app.slots.messageDirective({ id: "mail-draft", component: DraftDirective });
});
