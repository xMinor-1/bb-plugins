// Sharing comments through PDFs, in the panel: the download menu that offers
// a PDF with the comments in it, and the bar over a PDF that carries another
// reviewer's comments, with buttons to bring them in.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { defineMessages, getLang, messagesNow, pluralRu, useMessages } from "@/lib/i18n";
import type { ViewerLink } from "../src/contract";
import type { ReviewDoc } from "../src/types";
import { errorText, useReviewRpc } from "./use-review";

const commentsRu = (n: number) => pluralRu(n, ["комментарий", "комментария", "комментариев"]);

const messages = defineMessages(
  {
    downloadName: (name: string) => `Download ${name}`,
    couldNotMake: (reason: string) => `Could not make the PDF: ${reason}`,
    download: "Download",
    original: "Original file",
    pdfWithComments: "PDF with comments",
    shareable: (n: number) =>
      `${n} comment${n === 1 ? "" : "s"} with drawings, readable in any PDF viewer. Doc Review in another bb imports them.`,
    nothingToShare: "No comments on pages or on the whole document yet.",
    signAs: "Sign as",
    yourName: "Your name",
    downloadPdf: "Download PDF",
    imported: (added: number, updated: number, into: string | null) => {
      const parts = [
        ...(added > 0 ? [`${added} new comment${added === 1 ? "" : "s"}`] : []),
        ...(updated > 0 ? [`replies on ${updated}`] : []),
      ];
      const what = parts.length > 0 ? `Imported ${parts.join(" and ")}` : "Nothing new to import";
      if (into !== null) return `${what} into ${into}.`;
      return added > 0 ? `${what}. New comments wait as drafts.` : `${what}.`;
    },
    open: "Open",
    couldNotImport: (reason: string) => `Could not import the comments: ${reason}`,
    anotherReviewer: "Another reviewer",
    leftBefore: (n: number) => ` left ${n} comment${n === 1 ? "" : "s"} on `,
    leftAfter: " in this PDF. Import them to reply, change them, or send them to an agent.",
    importInto: (file: string) => `Import into ${file}`,
    importHere: "Import here",
    import: "Import",
    hide: "Hide",
  },
  {
    downloadName: (name) => `Скачать ${name}`,
    couldNotMake: (reason) => `Не удалось собрать PDF: ${reason}`,
    download: "Скачать",
    original: "Исходный файл",
    pdfWithComments: "PDF с комментариями",
    shareable: (n) =>
      `${n} ${commentsRu(n)} с рисунками, открывается в любой программе для PDF. Doc Review в другом bb импортирует их.`,
    nothingToShare: "Пока нет комментариев к страницам или ко всему документу.",
    signAs: "Подпись",
    yourName: "Ваше имя",
    downloadPdf: "Скачать PDF",
    imported: (added, updated, into) => {
      const parts = [
        ...(added > 0 ? [`${added} ${pluralRu(added, ["новый комментарий", "новых комментария", "новых комментариев"])}`] : []),
        ...(updated > 0 ? [`ответы на ${updated} ${commentsRu(updated)}`] : []),
      ];
      if (parts.length === 0) return "Нового для импорта нет.";
      const what = `Импортировано${into !== null ? ` в ${into}` : ""}: ${parts.join(" и ")}`;
      return into === null && added > 0 ? `${what}. Новые комментарии ждут в черновиках.` : `${what}.`;
    },
    open: "Открыть",
    couldNotImport: (reason) => `Не удалось импортировать комментарии: ${reason}`,
    anotherReviewer: "Другой рецензент",
    leftBefore: (n) => `: ${n} ${commentsRu(n)} к файлу `,
    leftAfter: " в этом PDF. Импортируйте их, чтобы ответить, изменить или отправить агенту.",
    importInto: (file) => `Импортировать в ${file}`,
    importHere: "Импортировать сюда",
    import: "Импортировать",
    hide: "Скрыть",
  },
);

/** Starts a download of `url` saved as `name`. */
function download(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The download button: the original file, and for paged documents a PDF
 * with the comments written in, signed with the name the user gives.
 */
export function DownloadMenu({
  doc,
  original,
  shareable,
}: {
  doc: ReviewDoc;
  original: ViewerLink;
  /** Comments that would go into the PDF; null when the document has no pages. */
  shareable: number | null;
}) {
  const t = useMessages(messages);
  const rpc = useReviewRpc();
  const [open, setOpen] = useState(false);
  const [signer, setSigner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || signer !== null) return;
    rpc.call("export.signer", null).then(
      (result) => setSigner((current) => current ?? result.signer ?? ""),
      () => setSigner((current) => current ?? ""),
    );
  }, [open, rpc, signer]);

  if (shareable === null) {
    return (
      <Button asChild type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground">
        <a href={original.url} download={doc.name} aria-label={t.downloadName(doc.name)}>
          <Icon name="Download" className="size-4" />
        </a>
      </Button>
    );
  }

  const exportPdf = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("doc.export", { docId: doc.id, signer: signer?.trim() || null, lang: getLang() });
      download(result.link.url, result.name);
      setOpen(false);
    } catch (cause) {
      toast.error(messagesNow(messages).couldNotMake(errorText(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={box} className="relative flex">
      <Button
        type="button"
        variant={open ? "secondary" : "ghost"}
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={t.download}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="Download" className="size-4" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
          <a
            href={original.url}
            download={doc.name}
            className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            <span>{t.original}</span>
            <span className="max-w-full truncate text-xs text-muted-foreground">{doc.name}</span>
          </a>
          <div className="my-1 h-px bg-border" />
          <form
            className="flex flex-col gap-2 px-2 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (shareable > 0 && !busy) void exportPdf();
            }}
          >
            <div>
              <div>{t.pdfWithComments}</div>
              <p className="text-xs text-muted-foreground">
                {shareable > 0 ? t.shareable(shareable) : t.nothingToShare}
              </p>
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t.signAs}
              <Input
                value={signer ?? ""}
                placeholder={t.yourName}
                maxLength={120}
                className="h-8 text-sm"
                onChange={(event) => setSigner(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={shareable === 0 || busy}>
              {busy ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="Download" className="size-3.5" />}
              {t.downloadPdf}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

interface SharedSummary {
  by: string | null;
  file: string;
  count: number;
  newHere: number;
  original: { path: string; newThere: number } | null;
}

/** What a PDF carries from another reviewer, refreshed when its comments change. */
export function useShared(doc: ReviewDoc, changes: unknown) {
  const rpc = useReviewRpc();
  const [shared, setShared] = useState<SharedSummary | null>(null);
  const load = useCallback(() => {
    if (doc.kind !== "pdf") return;
    rpc.call("doc.shared", { docId: doc.id }).then(
      (result) => setShared(result.shared),
      () => setShared(null),
    );
  }, [rpc, doc.id, doc.kind]);
  useEffect(() => load(), [load, doc.version, changes]);
  return { shared, reload: load };
}

/** The bar over a PDF with another reviewer's comments in it. */
export function SharedBanner({
  doc,
  shared,
  onImported,
  onOpen,
}: {
  doc: ReviewDoc;
  shared: SharedSummary;
  onImported: () => void;
  onOpen: (docId: string) => void;
}) {
  const t = useMessages(messages);
  const rpc = useReviewRpc();
  const [busy, setBusy] = useState<"here" | "original" | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const there = shared.original && shared.original.newThere > 0 ? shared.original : null;
  // Once they are on the file they were written on, the PDF has nothing more to offer.
  const done = shared.original !== null && !there;
  if (dismissed || done || (shared.newHere === 0 && !there)) return null;

  const bring = async (into: "here" | "original") => {
    setBusy(into);
    try {
      const result = await rpc.call("comments.import", { docId: doc.id, into });
      const now = messagesNow(messages);
      if (into === "here") toast.success(now.imported(result.added, result.updated, null));
      else
        toast.success(now.imported(result.added, result.updated, result.name), {
          action: { label: now.open, onClick: () => onOpen(result.docId) },
        });
      onImported();
    } catch (cause) {
      toast.error(messagesNow(messages).couldNotImport(errorText(cause)));
    } finally {
      setBusy(null);
    }
  };

  const who = shared.by ?? t.anotherReviewer;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-3 py-2 text-xs">
      <Icon name="MessageSquare" className="size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{who}</span>
        {t.leftBefore(shared.count)}
        <span className="font-medium">{shared.file}</span>
        {t.leftAfter}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        {there ? (
          <Button type="button" size="sm" className="h-7" disabled={busy !== null} onClick={() => void bring("original")}>
            {busy === "original" ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
            {t.importInto(shared.file)}
          </Button>
        ) : null}
        {shared.newHere > 0 ? (
          <Button
            type="button"
            size="sm"
            variant={there ? "outline" : "default"}
            className="h-7"
            disabled={busy !== null}
            onClick={() => void bring("here")}
          >
            {busy === "here" ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
            {there ? t.importHere : t.import}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={t.hide}
          onClick={() => setDismissed(true)}
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
