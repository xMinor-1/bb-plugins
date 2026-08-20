// bb-plugin-theme-toggle — палитра BB + режим светлая/тёмная одной кнопкой.
//
// Палитра живёт на сервере (bb.sdk.theme), режим light/dark — клиентский
// (localStorage `bb.theme`), поэтому режимом занимается app.tsx.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Встроенные палитры BB: каталог отдаёт только custom- и plugin-темы.
const BUILT_IN = [
  { id: "default", name: "Default" },
  { id: "nord", name: "Nord" },
  { id: "dracula", name: "Dracula" },
  { id: "solarized", name: "Solarized" },
  { id: "gruvbox", name: "Gruvbox" },
  { id: "catppuccin", name: "Catppuccin" },
];

const themeList = z.object({
  activeId: z.string(),
  themes: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: themeList },
  cycle: { input: z.null(), output: themeList },
  select: { input: z.object({ themeId: z.string() }), output: themeList },
});

export default async function plugin(bb: BbPluginApi) {
  async function read() {
    const catalog = await bb.sdk.theme.catalog();
    const themes = [
      ...BUILT_IN,
      ...catalog.custom.map((id) => ({ id, name: id })),
      // id тем плагинов уже namespaced (plugin:<pluginId>:<id>).
      ...catalog.plugins.map((t) => ({ id: t.id, name: t.name })),
    ];
    return { activeId: catalog.active.themeId, themes, catalog };
  }

  async function apply(themeId: string) {
    const { catalog } = await read();
    // faviconColor обязателен в selection — переносим текущий как есть.
    await bb.sdk.theme.set({ themeId, faviconColor: catalog.active.faviconColor });
    const next = await read();
    return { activeId: next.activeId, themes: next.themes };
  }

  bb.rpc.register(rpcContract, {
    async state() {
      const { activeId, themes } = await read();
      return { activeId, themes };
    },
    async cycle() {
      const { activeId, themes } = await read();
      const at = themes.findIndex((t) => t.id === activeId);
      return apply(themes[(at + 1) % themes.length]!.id);
    },
    async select({ themeId }) {
      return apply(themeId);
    },
  });
}
