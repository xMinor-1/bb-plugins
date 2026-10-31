// components/EmptyState.tsx — the four "nothing to show" states of the table
// body (§8): an empty directory, a search that matched nothing, a directory
// that turned out to be a symlink leaving the root, and the first-run hint.
//
// Rendered *inside* the scroll container, never as a full-panel takeover, so
// the toolbar and the drop target stay live behind it.
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { rootPhrase } from "../lib/fm-paths";
import { cn } from "../lib/utils";
import { defineMessages, useMessages } from "../lib/i18n";

export type EmptyStateKind = "empty" | "no-results" | "escapes-root" | "not-writable";

export interface EmptyStateProps {
  kind: EmptyStateKind;
  /** Echoed back in the "no results" copy. */
  query?: string;
  /**
   * The hard root, named in the "escapes-root" copy. It is the home directory
   * of whoever runs bb, so only the backend knows it: the panel passes
   * `state.root`, and the default reads the value the panel published.
   */
  root?: string;
  onClearSearch?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  className?: string;
}

const messages = defineMessages(
  {
    emptyTitle: "This folder is empty",
    emptyBody: "Drop files here to upload them, or create a folder.",
    noResultsTitle: "No matching items",
    noResultsBody: "Nothing in this folder matches your filter.",
    noResultsQuery: (query: string) => `Nothing in this folder matches “${query}”.`,
    escapesTitle: "Outside the home folder",
    escapesBody: (root: string) => `This link points outside ${root}, so it cannot be opened here.`,
    readOnlyTitle: "Read-only folder",
    readOnlyBody: "You can browse and download here, but not change anything.",
    clearFilter: "Clear filter",
    uploadFiles: "Upload files",
    newFolder: "New folder",
  },
  {
    emptyTitle: "Папка пуста",
    emptyBody: "Перетащите сюда файлы, чтобы загрузить их, или создайте папку.",
    noResultsTitle: "Ничего не найдено",
    noResultsBody: "В этой папке ничего не подходит под фильтр.",
    noResultsQuery: (query) => `В этой папке ничего не подходит под «${query}».`,
    escapesTitle: "Вне домашней папки",
    escapesBody: (root) => `Ссылка ведёт за пределы ${root}, поэтому здесь её не открыть.`,
    readOnlyTitle: "Папка только для чтения",
    readOnlyBody: "Здесь можно смотреть и скачивать, но ничего не изменить.",
    clearFilter: "Сбросить фильтр",
    uploadFiles: "Загрузить файлы",
    newFolder: "Новая папка",
  },
);

type Messages = (typeof messages)["en"];

interface Copy {
  icon: IconName;
  title: string;
  /** Plain text, or a function of the root phrase. */
  body: string | ((root: string) => string);
}

function copyFor(kind: EmptyStateKind, t: Messages): Copy {
  switch (kind) {
    case "empty":
      return { icon: "FolderOpen", title: t.emptyTitle, body: t.emptyBody };
    case "no-results":
      return { icon: "Search", title: t.noResultsTitle, body: t.noResultsBody };
    case "escapes-root":
      return { icon: "AlertTriangle", title: t.escapesTitle, body: t.escapesBody };
    case "not-writable":
      return { icon: "Lock", title: t.readOnlyTitle, body: t.readOnlyBody };
  }
}

export function EmptyState({
  kind,
  query,
  root,
  onClearSearch,
  onNewFolder,
  onUpload,
  className,
}: EmptyStateProps) {
  const t = useMessages(messages);
  const copy = copyFor(kind, t);
  const body =
    kind === "no-results" && query !== undefined && query !== ""
      ? t.noResultsQuery(query)
      : typeof copy.body === "function"
        ? copy.body(rootPhrase(root))
        : copy.body;

  return (
    <div
      data-testid="fm-empty-state"
      data-empty-kind={kind}
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-16 text-center",
        className,
      )}
    >
      <Icon name={copy.icon} className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
      <div className="mt-2 flex items-center gap-2">
        {kind === "no-results" && onClearSearch !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onClearSearch}>
            {t.clearFilter}
          </Button>
        ) : null}
        {kind === "empty" && onUpload !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onUpload}>
            <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
            {t.uploadFiles}
          </Button>
        ) : null}
        {kind === "empty" && onNewFolder !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onNewFolder}>
            <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
            {t.newFolder}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
