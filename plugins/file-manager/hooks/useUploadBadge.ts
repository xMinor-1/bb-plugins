// hooks/useUploadBadge.ts — the badge on the File Manager navigation entry.
//
// bb calls this hook for the registered nav panel whether or not the panel is
// open, and draws the count on the sidebar entry (a dot on More when the panel
// is hidden there). It reads the upload manager singleton directly rather than
// the panel bus: uploads keep running after the panel unmounts, and this is
// the only place that still shows them.
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";

import { useUploads } from "./useUploads";
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

export function useUploadBadge(): ExperimentalBadge | null {
  const t = useMessages(messages);
  const { activeCount, progress } = useUploads();
  if (activeCount === 0) return null;
  return {
    count: activeCount,
    label:
      progress === null
        ? t.inProgress(activeCount)
        : t.uploading(activeCount, formatPercent(progress.ratio)),
  };
}
