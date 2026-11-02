// bb-plugin-http-data-service — frontend entry: the sign-in page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DataServicePage } from "./src/app/DataServicePage";
import { Database, ICON } from "./src/app/icon";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON, component: Database });
  app.slots.navPanel({
    id: "data-service",
    title: "Data Service",
    icon: ICON,
    path: "data-service",
    component: DataServicePage,
  });
});
