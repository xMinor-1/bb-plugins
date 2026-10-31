// The Doc Review tab for files attached in the chat. bb opens an attachment's
// chip in its own preview, so this tab lists the thread's attached files and
// opens the chosen one for review: a copy in the thread's storage, made by
// the server (src/attachments.ts), shown by the same view as any file.
import { useCallback, useEffect, useState } from "react";
import type { JsonValue, PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { defineMessages, LanguageSwitch, messagesNow, useMessages } from "@/lib/i18n";
import { ReviewOpener } from "./review-opener";
import { iconFor } from "./reviews-page";
import { errorText, useReviewRpc } from "./use-review";

interface AttachedFile {
  name: string;
  path: string;
  supported: boolean;
}

/** What a message action passes: the message whose files to show. */
function readSeq(params: JsonValue | null): number | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const seq = params.seq;
  return typeof seq === "number" && Number.isInteger(seq) ? seq : null;
}

const messages = defineMessages(
  {
    noOriginal: "The file's own preview opens from its chip in the chat.",
    couldNotOpen: (name: string, reason: string) => `Could not open ${name}: ${reason}`,
    attachedFiles: "Attached files",
    inThisChat: "Files attached in this chat",
    onThisMessage: "Files on this message",
    copyNote: "Doc Review opens a copy kept with this chat, so the agent works on the file you comment on.",
    noFiles: "No files are attached in this chat yet.",
    notDocument: "Not a document",
  },
  {
    noOriginal: "Обычный просмотр файла открывается по его вложению в треде.",
    couldNotOpen: (name, reason) => `Не удалось открыть ${name}: ${reason}`,
    attachedFiles: "Вложенные файлы",
    inThisChat: "Файлы, вложенные в этот тред",
    onThisMessage: "Файлы этого сообщения",
    copyNote: "Doc Review открывает копию, которая хранится с этим тредом, — агент правит тот же файл, который вы комментируете.",
    noFiles: "В этом треде пока нет вложенных файлов.",
    notDocument: "Не документ",
  },
);

function NoOriginal() {
  const t = useMessages(messages);
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {t.noOriginal}
    </div>
  );
}

export function AttachmentTab({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const t = useMessages(messages);
  const rpc = useReviewRpc();
  const seq = readSeq(params);
  const [files, setFiles] = useState<AttachedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; path: string } | null>(null);

  const open = useCallback(
    (file: AttachedFile) => {
      setOpening(file.path);
      setError(null);
      rpc.call("attachments.open", { threadId, path: file.path, name: file.name }).then(
        (result) => {
          setShown({ name: file.name, path: result.path });
          setOpening(null);
        },
        (cause: unknown) => {
          setError(messagesNow(messages).couldNotOpen(file.name, errorText(cause)));
          setOpening(null);
        },
      );
    },
    [rpc, threadId],
  );

  useEffect(() => {
    let alive = true;
    rpc.call("attachments.list", { threadId, seq }).then(
      (result) => {
        if (!alive) return;
        setFiles(result.files);
        // One file to review: straight to it.
        const reviewable = result.files.filter((file) => file.supported);
        if (reviewable.length === 1 && reviewable[0]) open(reviewable[0]);
      },
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, threadId, seq, open]);

  if (shown) {
    const source: PluginFileOpenerSource = { kind: "thread-storage", threadId, environmentId: null, projectId: null };
    const others = (files ?? []).filter((file) => file.supported).length > 1;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {others ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setShown(null)}>
              <Icon name="ArrowLeft" className="size-3.5" />
              {t.attachedFiles}
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <ReviewOpener path={shown.path} source={source} Original={NoOriginal} />
        </div>
      </div>
    );
  }

  if (!files && !error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Icon name="Loading" className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 font-medium">{seq === null ? t.inThisChat : t.onThisMessage}</h2>
        <LanguageSwitch />
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t.copyNote}</p>
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
      {files && files.length === 0 ? (
        <p className="text-muted-foreground">{t.noFiles}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {(files ?? []).map((file) => (
          <li key={file.path}>
            <button
              type="button"
              disabled={!file.supported || opening !== null}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
              onClick={() => open(file)}
            >
              <Icon name={iconFor(file.name)} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              {opening === file.path ? (
                <Icon name="Loading" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : !file.supported ? (
                <span className="shrink-0 text-xs text-muted-foreground">{t.notDocument}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
