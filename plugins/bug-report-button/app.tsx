// bb-plugin-bug-report-button — frontend: a sidebar item with a bug that opens the report page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BugIcon } from "./components/BugIcon";
import { ReportPage } from "./components/ReportPage";
import { PANEL_ID, PANEL_TITLE } from "./src/reveal";
import "./app.css";

const ICON = "bug-report-button.bug";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON, component: ({ className }) => <BugIcon className={className} /> });
  app.slots.navPanel({ id: PANEL_ID, title: PANEL_TITLE, icon: ICON, path: PANEL_ID, component: ReportPage });
});
