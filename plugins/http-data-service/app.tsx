// bb-plugin-http-data-service — frontend entry: the sign-in page in the left sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DataServicePage } from "./src/app/DataServicePage";
import { Database, ICON } from "./src/app/icon";
import { rememberedTitle, useServiceName } from "./src/app/service-name";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON, component: Database });
  const title = rememberedTitle();
  app.slots.navPanel({
    id: "data-service",
    title,
    icon: ICON,
    path: "data-service",
    component: DataServicePage,
    // bb runs this hook at start for every panel: it learns the name without the page being opened.
    experimental_useBadge: () => {
      useServiceName();
      return null;
    },
    experimental_usePageTitle: () => {
      const name = useServiceName();
      return name && name !== title ? { title: name } : null;
    },
  });
});
