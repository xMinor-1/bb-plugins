// One selected-entry policy shared by every menu surface.
//
// Context menus and touch drawers paint differently, but action visibility,
// enablement, order and behavior must never diverge between them (§8.2).
import type { FileEntry } from "../contract";
import { isViewableEntry } from "../lib/viewer";
import { effectiveKind } from "./FileRow";
import type { IconName } from "./ui/icon";
import { actionMessages } from "./action-messages";
import { messagesNow } from "../lib/i18n";

export interface SelectedEntryActionsProps {
  /** Everything the action applies to; never empty when a surface renders. */
  entries: readonly FileEntry[];
  /** False when `listDir` said the current directory is read-only. */
  writable: boolean;
  canPaste: boolean;
  /** True when at least one extractor exists for the selected archive. */
  canExtract: boolean;
  /**
   * What `Enter` and a double-click do: walk into a folder, extract an
   * archive, show a file. One callback for all three because the menu should
   * not be the second place that decides which is which.
   */
  onOpen: (entry: FileEntry) => void;
  onDownload: () => void;
  /** One @-mention per selected file, into whatever composer is in reach (§8.8). */
  onAddToChat: () => void;
  onExtract: (entry: FileEntry) => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMoveTo: () => void;
  onCopyTo: () => void;
  onRename: (entry: FileEntry) => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onSetStartFolder: (entry: FileEntry) => void;
  onProperties: () => void;
  /** True when the single directory row is already bookmarked (§8.11). */
  bookmarked: boolean;
  /** False only while the list has not arrived yet. */
  canToggleBookmark: boolean;
  onToggleBookmark: (entry: FileEntry) => void;
}

export type SelectedEntryActionId =
  | "open"
  | "download"
  | "add-to-chat"
  | "extract"
  | "cut"
  | "copy"
  | "paste"
  | "move-to"
  | "copy-to"
  | "rename"
  | "copy-path"
  | "set-start-folder"
  | "bookmark"
  | "properties"
  | "delete";

export interface SelectedEntryAction {
  id: SelectedEntryActionId;
  label: string;
  icon: IconName;
  disabled: boolean;
  destructive?: boolean;
  /** Selection count displayed on every surface. */
  trailing?: string;
  /** Desktop-only keyboard hint. */
  shortcut?: string;
  run: () => void;
}

export interface SelectedEntryActionModel {
  label: string;
  groups: readonly (readonly SelectedEntryAction[])[];
}

export function selectedEntryActionModel(
  props: SelectedEntryActionsProps,
): SelectedEntryActionModel {
  const { entries, writable, canPaste, canExtract, bookmarked, canToggleBookmark } = props;
  // Built during render: the menus that call this subscribe to the language.
  const t = messagesNow(actionMessages);
  const single = entries.length === 1 ? entries[0] : undefined;
  const directory = single !== undefined && effectiveKind(single) === "directory";
  const escapes = entries.some((entry) => entry.escapesRoot);
  // "Add to chat" acts on exactly the real files in the selection: a folder
  // has no bytes to mention. "Download" takes folders too — anything beyond
  // one file leaves as a zip. A link out of the root is refused by the server
  // either way (§6).
  const files = entries.filter(
    (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
  );
  const downloadable = entries.filter((entry) => {
    const kind = effectiveKind(entry);
    return !entry.escapesRoot && (kind === "file" || kind === "directory");
  });
  const archive = single !== undefined && single.archiveFormat !== null ? single : undefined;
  // Folders only, and one at a time: a bookmark or a start folder is a place
  // to go, and a file (or a selection of five) is not one.
  const folderAction = single !== undefined && directory && !escapes;
  // One row, one Open: a folder to walk into, an archive to extract, or a file
  // to read. Multiple rows have no single destination, and a link out of the
  // root has nothing this plugin is allowed to follow.
  const openable =
    single !== undefined && !escapes && (directory || isViewableEntry(single))
      ? single
      : undefined;

  const transfer: SelectedEntryAction[] = [];
  if (openable !== undefined) {
    transfer.push({
      id: "open",
      label: t.open,
      icon: directory ? "FolderOpen" : openable.archiveFormat !== null ? "ArchiveRestore" : "Eye",
      disabled: false,
      shortcut: "Enter",
      run: () => props.onOpen(openable),
    });
  }
  // "Add to chat" sits beside Download because it answers the same question —
  // "take this file somewhere" — with the other destination: the agent.
  transfer.push(
    {
      id: "download",
      label: downloadable.length === 1 && files.length === 1 ? t.download : t.downloadZip,
      icon: "Download",
      disabled: downloadable.length === 0,
      trailing: downloadable.length > 1 ? String(downloadable.length) : undefined,
      run: props.onDownload,
    },
    {
      id: "add-to-chat",
      label: t.addToChat,
      icon: "MessageSquarePlus",
      disabled: files.length === 0,
      trailing: files.length > 1 ? String(files.length) : undefined,
      run: props.onAddToChat,
    },
  );
  if (archive !== undefined) {
    transfer.push({
      id: "extract",
      label: t.extract,
      icon: "ArchiveRestore",
      disabled: !canExtract || !writable,
      run: () => props.onExtract(archive),
    });
  }

  const organize: SelectedEntryAction[] = [
    { id: "cut", label: t.cut, icon: "Layers", disabled: escapes, shortcut: "Ctrl+X", run: props.onCut },
    { id: "copy", label: t.copy, icon: "Copy", disabled: escapes, shortcut: "Ctrl+C", run: props.onCopy },
    {
      id: "paste",
      label: t.paste,
      icon: "PackageReceive",
      disabled: !canPaste || !writable,
      shortcut: "Ctrl+V",
      run: props.onPaste,
    },
  ];
  const destinations: SelectedEntryAction[] = [
    { id: "move-to", label: t.moveTo, icon: "FolderExport", disabled: escapes, run: props.onMoveTo },
    { id: "copy-to", label: t.copyTo, icon: "Folder", disabled: escapes, run: props.onCopyTo },
  ];
  const details: SelectedEntryAction[] = [
    {
      id: "rename",
      label: t.rename,
      icon: "Edit",
      disabled: single === undefined || !writable,
      shortcut: "F2",
      run: () => {
        if (single !== undefined) props.onRename(single);
      },
    },
    { id: "copy-path", label: t.copyPath, icon: "Paperclip", disabled: false, run: props.onCopyPath },
  ];
  if (folderAction) {
    details.push(
      {
        id: "set-start-folder",
        label: t.setStartFolder,
        icon: "Pin",
        disabled: false,
        run: () => props.onSetStartFolder(single),
      },
      {
        id: "bookmark",
        label: bookmarked ? t.removeBookmark : t.bookmark,
        icon: bookmarked ? "PinOff" : "Star",
        disabled: !canToggleBookmark,
        run: () => props.onToggleBookmark(single),
      },
    );
  }
  details.push({
    id: "properties",
    label: t.properties,
    icon: "Info",
    disabled: false,
    shortcut: "Alt+Enter",
    run: props.onProperties,
  });

  return {
    label: single === undefined ? t.items(entries.length) : single.name,
    groups: [
      transfer,
      organize,
      destinations,
      details,
      [
        {
          id: "delete",
          label: t.delete,
          icon: "Trash2",
          disabled: !writable,
          destructive: true,
          shortcut: "Del",
          run: props.onDelete,
        },
      ],
    ],
  };
}
