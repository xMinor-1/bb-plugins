// bb-plugin-qlik-sense — frontend entry: the Qlik Sense page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { QlikPage } from "./src/app/QlikPage";
import { ChartPie, ICON } from "./src/app/icon";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON, component: ChartPie });
  app.slots.navPanel({
    id: "qlik-sense",
    title: "Qlik Sense",
    icon: ICON,
    path: "qlik-sense",
    component: QlikPage,
  });
});
