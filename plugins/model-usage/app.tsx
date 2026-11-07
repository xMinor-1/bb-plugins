// bb-plugin-model-usage — frontend: the footer button with Claude Code's
// rings and its card, the Usage page, and a background refresh of the shared
// figures while the window is in use.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { getLang } from "./lib/i18n";
import { refresh, setPluginId } from "./lib/store";
import { FooterCard } from "./components/FooterCard";
import { RingsIcon } from "./components/Rings";
import { PANEL_PATH, UsagePage } from "./components/UsagePage";

const ICON = "model-usage-rings";
/** The rings follow the limits poll on the server: five minutes. */
const BACKGROUND_MAX_AGE_MS = 5 * 60_000;

export default definePluginApp((app) => {
  const ru = getLang() === "ru";
  app.experimental_icons.register({ name: ICON, component: RingsIcon });

  app.slots.navPanel({
    id: "usage",
    title: ru ? "Расход моделей" : "Model usage",
    icon: "ChartColumn",
    path: PANEL_PATH,
    component: UsagePage,
  });

  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: ru ? "Расход моделей" : "Model usage",
    icon: ICON as never,
    component: FooterCard,
  });

  // Keeps the rings current while the window is in use; quiet in a hidden tab.
  app.contentScripts.register({
    id: "refresh",
    mount({ pluginId, signal }) {
      setPluginId(pluginId);
      let timer: number | null = null;
      const schedule = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted || document.visibilityState !== "visible") return;
        timer = window.setTimeout(run, BACKGROUND_MAX_AGE_MS);
      };
      const run = () => {
        void refresh({ maxAgeMs: BACKGROUND_MAX_AGE_MS, signal }).catch(() => undefined);
        schedule();
      };
      const onVisible = () => {
        if (document.visibilityState === "visible") run();
        else if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      run();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  });
});
