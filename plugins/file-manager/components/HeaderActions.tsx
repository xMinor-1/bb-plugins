// components/HeaderActions.tsx — the panel's slice of the shared title bar.
//
// Mounted by the host *outside* the panel component's subtree, so it talks to
// the body through components/panel-bus.ts rather than React context. Every
// button dispatches synchronously inside the click handler, which is what
// keeps the panel's hidden <input type="file"> click a real user gesture.
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./ui/icon";
import { sendPanelCommand, usePanelSnapshot } from "./panel-bus";
import { actionMessages } from "./action-messages";
import { LanguageSwitch, useMessages } from "../lib/i18n";

export function HeaderActions(_props: PluginNavPanelProps) {
  const t = useMessages(actionMessages);
  const panel = usePanelSnapshot();
  const disabled = !panel.ready || !panel.writable;

  return (
    <div className="flex items-center gap-1" data-testid="fm-header-actions">
      <LanguageSwitch className="mr-1" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2"
        disabled={disabled}
        data-testid="fm-header-upload"
        onClick={() => sendPanelCommand({ type: "upload" })}
      >
        <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t.upload}</span>
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2"
        disabled={disabled}
        data-testid="fm-header-new-folder"
        onClick={() => sendPanelCommand({ type: "new-folder" })}
      >
        <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t.newFolder}</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            aria-label={t.moreActions}
            data-testid="fm-header-overflow"
          >
            <Icon name="MoreHorizontal" className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!panel.ready}
            onSelect={() => sendPanelCommand({ type: "refresh" })}
          >
            <Icon name="ArrowReloadHorizontal" className="size-4" aria-hidden="true" />
            {t.refresh}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!panel.ready}
            onSelect={() => sendPanelCommand({ type: "toggle-hidden" })}
          >
            <Icon name={panel.showHidden ? "EyeOff" : "Eye"} className="size-4" aria-hidden="true" />
            {panel.showHidden ? t.hideHidden : t.showHiddenAction}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!panel.ready}
            onSelect={() => sendPanelCommand({ type: "select-all" })}
          >
            <Icon name="Check" className="size-4" aria-hidden="true" />
            {t.selectAll}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!panel.canPaste || disabled}
            onSelect={() => sendPanelCommand({ type: "paste" })}
          >
            <Icon name="Copy" className="size-4" aria-hidden="true" />
            {t.paste}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!panel.ready}
            onSelect={() => sendPanelCommand({ type: "copy-path" })}
          >
            <Icon name="Paperclip" className="size-4" aria-hidden="true" />
            {t.copyFolderPath}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!panel.ready}
            onSelect={() => sendPanelCommand({ type: "set-start-folder" })}
          >
            <Icon name="Pin" className="size-4" aria-hidden="true" />
            {t.setStartFolder}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
