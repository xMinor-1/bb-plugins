// bb-plugin-qlik-sense — frontend entry: the Qlik Sense page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { QlikPage } from "./src/app/QlikPage";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "qlik-sense",
    title: "Qlik Sense",
    icon: "ChartColumn",
    path: "qlik-sense",
    component: QlikPage,
  });
});
