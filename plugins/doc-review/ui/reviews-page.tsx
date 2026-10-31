// The "Doc Review" sidebar page: files with comments and where they stand,
// recent files, a folder browser, a field to open any file by path, and a
// full-page view of one file.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  useBbNavigate,
  useRealtime,
  type PluginFileOpenerSource,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { defineMessages, LanguageSwitch, useMessages } from "@/lib/i18n";
import { familyIcon } from "@/components/viewer/family";
import type { RecentDocument } from "../src/contract";
import { docKindFor, type ReviewDoc } from "../src/types";
import { Workspace } from "./review-opener";
import { errorText, useDocVersion, useReviewRpc } from "./use-review";

export const PANEL_PATH = "doc-review";

const HOST_SOURCE: PluginFileOpenerSource = {
  kind: "host",
  threadId: null,
  environmentId: null,
  projectId: null,
};

interface DocSummary {
  id: string;
  kind: ReviewDoc["kind"];
  name: string;
  absPath: string;
  counts: { draft: number; sent: number; replied: number; resolved: number };
  lastActivity: number;
}

const messages = defineMessages(
  {
    answered: (n: number) => `${n} answered`,
    drafts: (n: number) => `${n} draft${n === 1 ? "" : "s"}`,
    waiting: (n: number) => `${n} waiting`,
    done: (n: number) => `${n} done`,
    intro:
      "Read Markdown, PDF, Word, PowerPoint, Excel, and HTML files and comment on them. Files opened from a chat land in a tab beside it; send the comments to the agent from there.",
    pathPlaceholder: "/absolute/path/to/file.docx",
    fileToOpen: "File to open",
    open: "Open",
    withComments: "With comments",
    recent: "Recent",
    clear: "Clear",
    browse: "Browse",
    parentFolder: "Parent folder",
    loading: "Loading…",
    noDocuments: "No documents here.",
    backToList: "Back to the list",
    allFiles: "All files",
  },
  {
    answered: (n) => `с ответом: ${n}`,
    drafts: (n) => `черновики: ${n}`,
    waiting: (n) => `ждут: ${n}`,
    done: (n) => `готово: ${n}`,
    intro:
      "Читайте и комментируйте файлы Markdown, PDF, Word, PowerPoint, Excel и HTML. Файл, открытый из треда, встаёт во вкладку рядом с ним — оттуда комментарии и отправляются агенту.",
    pathPlaceholder: "/полный/путь/к/файлу.docx",
    fileToOpen: "Какой файл открыть",
    open: "Открыть",
    withComments: "С комментариями",
    recent: "Недавние",
    clear: "Очистить",
    browse: "Папки",
    parentFolder: "Папка выше",
    loading: "Загружаем…",
    noDocuments: "Здесь нет документов.",
    backToList: "Назад к списку",
    allFiles: "Все файлы",
  },
);

function Counts({ counts }: { counts: DocSummary["counts"] }) {
  const t = useMessages(messages);
  const parts = [
    counts.replied ? t.answered(counts.replied) : null,
    counts.draft ? t.drafts(counts.draft) : null,
    counts.sent ? t.waiting(counts.sent) : null,
    counts.resolved ? t.done(counts.resolved) : null,
  ].filter(Boolean);
  return <span>{parts.join(" · ")}</span>;
}

export function iconFor(path: string): string {
  // A live site is listed by its address.
  if (/^https?:\/\//.test(path)) return "Globe";
  const kind = docKindFor(path);
  if (kind === "html") return "Code";
  return kind === "md" || kind === "web" || kind === null ? "FileText" : familyIcon(kind);
}

interface BrowseEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** How many recent files the page lists. */
const RECENTS_SHOWN = 6;

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function FileRow({ path, title, detail, onOpen }: { path: string; title: string; detail?: ReactNode; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50"
      onClick={onOpen}
    >
      <Icon name={iconFor(path)} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{path}</span>
        {/* On a narrow page the status goes under the path, so the name keeps its room. */}
        {detail ? <span className="block text-xs text-muted-foreground @lg:hidden">{detail}</span> : null}
      </span>
      {detail ? <span className="hidden shrink-0 text-xs text-muted-foreground @lg:block">{detail}</span> : null}
    </button>
  );
}

function DocList() {
  const t = useMessages(messages);
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [folder, setFolder] = useState<{
    hostId: string;
    directory: string;
    parent: string | null;
    entries: BrowseEntry[];
  } | null>(null);

  const refetch = useCallback(() => {
    rpc.call("docs.list").then(
      (result) => {
        setDocs(result.docs);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
    rpc.call("recents").then((result) => setRecents(result.recents), () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("review-changed", refetch);

  const browse = useCallback(
    (next: { hostId?: string | null; path?: string | null }) => {
      rpc.call("browse", { hostId: next.hostId ?? null, path: next.path ?? null }).then(
        (listing) => setFolder(listing),
        (cause: unknown) => setError(errorText(cause)),
      );
    },
    [rpc],
  );
  useEffect(() => browse({}), [browse]);

  const openFile = async (target: string, hostId: string | null) => {
    if (opening) return;
    setOpening(true);
    try {
      const { doc } = await rpc.call("doc.open", {
        path: target,
        source: { ...HOST_SOURCE, experimental_hostId: hostId },
        remember: true,
      });
      navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOpening(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = path.trim();
    if (target) void openFile(target, null);
  };

  const crumbs = folder
    ? folder.directory
        .split("/")
        .filter(Boolean)
        .map((segment, index, all) => ({ name: segment, path: `/${all.slice(0, index + 1).join("/")}` }))
    : [];

  return (
    <div className="@container h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t.intro}</p>
          <LanguageSwitch />
        </div>
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t.pathPlaceholder}
            aria-label={t.fileToOpen}
          />
          <Button type="submit" disabled={opening || !path.trim()}>
            <Icon name={opening ? "Loading" : "FileText"} className={opening ? "size-4 animate-spin" : "size-4"} />
            {t.open}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {docs && docs.length > 0 ? (
          <Section title={t.withComments}>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {docs.map((doc) => (
                <FileRow
                  key={doc.id}
                  path={doc.absPath}
                  title={doc.name}
                  detail={<Counts counts={doc.counts} />}
                  onOpen={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` })}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {recents.length > 0 ? (
          <Section
            title={t.recent}
            action={
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => rpc.call("recents.clear").then((result) => setRecents(result.recents), () => undefined)}
              >
                {t.clear}
              </button>
            }
          >
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {recents.slice(0, RECENTS_SHOWN).map((recent) => (
                <FileRow
                  key={`${recent.hostId ?? "local"}:${recent.path}`}
                  path={recent.path}
                  title={recent.name}
                  onOpen={() => void openFile(recent.path, recent.hostId)}
                />
              ))}
            </div>
          </Section>
        ) : null}

        <Section title={t.browse}>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={!folder?.parent}
                aria-label={t.parentFolder}
                onClick={() => folder && browse({ hostId: folder.hostId, path: folder.parent })}
              >
                <Icon name="ChevronLeft" className="size-4" />
              </Button>
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex items-center gap-1">
                  {index > 0 ? <span aria-hidden>/</span> : null}
                  <button
                    type="button"
                    className="rounded px-1 hover:bg-accent hover:text-foreground"
                    onClick={() => folder && browse({ hostId: folder.hostId, path: crumb.path })}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            <div className="max-h-96 overflow-y-auto py-1">
              {folder === null ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">{t.loading}</p>
              ) : folder.entries.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">{t.noDocuments}</p>
              ) : (
                folder.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/50"
                    onClick={() =>
                      entry.kind === "directory"
                        ? browse({ hostId: folder.hostId, path: entry.path })
                        : void openFile(entry.path, folder.hostId)
                    }
                  >
                    <Icon
                      name={entry.kind === "directory" ? "Folder" : iconFor(entry.name)}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function DocPage({ docId }: { docId: string }) {
  const t = useMessages(messages);
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDocVersion(doc, setDoc);

  useEffect(() => {
    let alive = true;
    rpc.call("doc.get", { docId }).then(
      (result) => alive && setDoc(result.doc),
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, docId]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          {t.backToList}
        </Button>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Icon name="Loading" className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => navigate.toPluginPanel(PANEL_PATH)}
        >
          <Icon name="ChevronLeft" className="size-4" />
          {t.allFiles}
        </Button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{doc.absPath}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Workspace doc={doc} source={HOST_SOURCE} />
      </div>
    </div>
  );
}

export function ReviewsPage({ subPath }: PluginNavPanelProps) {
  const match = /^doc\/(d_[a-f0-9]+)/.exec(subPath);
  return match ? <DocPage key={match[1]} docId={match[1]!} /> : <DocList />;
}
