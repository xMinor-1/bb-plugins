// Russian text for bb's settings, first run and dialogs. It follows the language picked in this
// repository's other plugins (or the browser's language), so English stays the default elsewhere.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { getLang } from "./lib/i18n";
import { dictionary } from "./src/dictionary";
import { startTranslator } from "./src/translate";

// lib/i18n.tsx is a shared copy that does not export its subscription, so the same events are watched here.
const LANG_EVENTS = ["xminor-plugins:lang-change", "storage", "languagechange"] as const;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "russian-ui",
    mount() {
      let stop: (() => void) | null = null;
      const sync = () => {
        const wanted = getLang() === "ru";
        if (wanted && !stop) stop = startTranslator(document, dictionary);
        if (!wanted && stop) {
          stop();
          stop = null;
        }
      };
      sync();
      for (const name of LANG_EVENTS) window.addEventListener(name, sync);
      return () => {
        for (const name of LANG_EVENTS) window.removeEventListener(name, sync);
        stop?.();
      };
    },
  });
});
