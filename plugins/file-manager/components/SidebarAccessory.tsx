// components/SidebarAccessory.tsx — the trailing edge of the sidebar row.
//
// The host clips this to a small single-line box and hides it on compact
// viewports, so it is text only (§10). It reads the upload manager singleton
// directly rather than the panel bus: uploads keep running after the panel
// unmounts, and this is the only place that still shows them.
import { useUploads } from "../hooks/useUploads";
import { formatPercent } from "../lib/format";

export function SidebarAccessory() {
  const { activeCount, progress } = useUploads();
  if (activeCount === 0) return null;

  return (
    <span
      data-testid="fm-sidebar-accessory"
      title={
        progress === null
          ? `${String(activeCount)} upload${activeCount === 1 ? "" : "s"} in progress`
          : `${String(activeCount)} uploading — ${formatPercent(progress.ratio)}`
      }
      className="text-xs tabular-nums text-muted-foreground"
    >
      {activeCount}
    </span>
  );
}
