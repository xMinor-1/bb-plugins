// bb-plugin-doc-review — frontend entry.
//
// One file opener for Markdown, PDF, Word, PowerPoint, Excel, and HTML: files open
// in a panel tab beside the chat, where they can be read and commented on
// (see ui/review-opener.tsx). In the desktop app, a Review button beside the
// address bar of bb's browser does the same on a live site (ui/web-review.tsx).
// The sidebar page lists files and sites with comments, recent files, and a
// folder browser. Files attached in the chat open from a message's action bar
// into a Doc Review tab beside the chat (ui/attachment-tab.tsx): bb shows an
// attachment's chip in its own preview, which no file opener reaches.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { defineMessages, messagesNow } from "./lib/i18n";
import {
  PDF_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./lib/formats";
import { HTML_EXTENSIONS, MARKDOWN_EXTENSIONS } from "./src/types";
import { AttachmentTab } from "./ui/attachment-tab";
import { ReviewOpener } from "./ui/review-opener";
import { PANEL_PATH, ReviewsPage } from "./ui/reviews-page";
import { WebReviewAction } from "./ui/web-review";

// Registered once at load: a language picked later shows after a page reload.
const messages = defineMessages(
  {
    openerTitle: "Doc Review (view and comment)",
    tabTooltip: "Review files attached in this chat",
    actionTitle: "Review attached files in Doc Review",
  },
  {
    openerTitle: "Doc Review (смотреть и комментировать)",
    tabTooltip: "Ревью файлов, вложенных в этот тред",
    actionTitle: "Открыть вложенные файлы в Doc Review",
  },
);

export default definePluginApp((app) => {
  const t = messagesNow(messages);
  app.slots.fileOpener({
    id: "review",
    title: t.openerTitle,
    extensions: [
      ...MARKDOWN_EXTENSIONS,
      ...PDF_EXTENSIONS,
      ...TEXT_EXTENSIONS,
      ...PRESENTATION_EXTENSIONS,
      ...SPREADSHEET_EXTENSIONS,
      ...HTML_EXTENSIONS,
    ],
    component: ReviewOpener,
  });

  app.slots.experimental_browserToolbarAction({
    id: "review",
    title: "Doc Review",
    component: WebReviewAction,
  });

  app.slots.experimental_tab({
    id: "attachments",
    title: "Doc Review",
    tooltip: t.tabTooltip,
    icon: "FileText",
    layout: "flush",
    context: { kind: "thread" },
    availability: "action",
    component: AttachmentTab,
  });

  app.slots.messageAction({
    id: "review-attachments",
    title: t.actionTitle,
    icon: "FileText",
    run: (context) => {
      context.openPanel({
        actionId: "attachments",
        title: "Doc Review",
        params: { seq: context.message.experimental_messageSeq },
      });
    },
  });

  app.slots.navPanel({
    id: "doc-review",
    title: "Doc Review",
    icon: "FileText",
    path: PANEL_PATH,
    component: ReviewsPage,
  });
});
