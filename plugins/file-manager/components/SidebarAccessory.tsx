// components/SidebarAccessory.tsx — the trailing edge of the sidebar row.
//
// The host clips this to a small single-line box and hides it on compact
// viewports, so it is text only (§10). It reads the upload manager singleton
// directly rather than the panel bus: uploads keep running after the panel
// unmounts, and this is the only place that still shows them.
import { useUploads } from "../hooks/useUploads";
import { formatPercent } from "../lib/format";
import { defineMessages, pluralRu, useMessages } from "../lib/i18n";

const messages = defineMessages(
  {
    inProgress: (count: number) => `${String(count)} upload${count === 1 ? "" : "s"} in progress`,
    uploading: (count: number, percent: string) => `${String(count)} uploading — ${percent}`,
  },
  {
    inProgress: (count) =>
      `${pluralRu(count, ["Идёт", "Идут", "Идёт"])} ${String(count)} ${pluralRu(count, ["загрузка", "загрузки", "загрузок"])}`,
    uploading: (count, percent) =>
      `${pluralRu(count, ["Загружается", "Загружаются", "Загружаются"])} ${String(count)} — ${percent}`,
  },
);

export function SidebarAccessory() {
  const t = useMessages(messages);
  const { activeCount, progress } = useUploads();
  if (activeCount === 0) return null;

  return (
    <span
      data-testid="fm-sidebar-accessory"
      title={
        progress === null
          ? t.inProgress(activeCount)
          : t.uploading(activeCount, formatPercent(progress.ratio))
      }
      className="text-xs tabular-nums text-muted-foreground"
    >
      {activeCount}
    </span>
  );
}
