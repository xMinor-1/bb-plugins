// A message's attachments: open or save each file from the panel. Opening is
// only for formats a browser shows without running anything (PDF, pictures,
// plain text); anything else — HTML, SVG, Office files — is saved instead, so
// a file from a stranger never runs inside bb's page.
import { useState } from "react";
import type { MessageAttachment } from "../../contract";
import { ATTACHMENT_MAX_BYTES } from "../shared/limits";
import { Button } from "@/components/ui/button";
import { defineMessages, useMessages } from "@/lib/i18n";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";

const texts = defineMessages(
  {
    title: "Attachments",
    open: "Open",
    save: "Save",
    loading: "Loading…",
    inOutlook: "opens in Outlook",
    tooLarge: (mb: number) => `over ${mb} MB, open it in Outlook`,
    bytes: (n: number) => `${n} B`,
    kilobytes: (n: number) => `${n} KB`,
    megabytes: (n: string) => `${n} MB`,
  },
  {
    title: "Вложения",
    open: "Открыть",
    save: "Сохранить",
    loading: "Загружаю…",
    inOutlook: "открывается в Outlook",
    tooLarge: (mb) => `больше ${mb} МБ, откройте в Outlook`,
    bytes: (n) => `${n} Б`,
    kilobytes: (n) => `${n} КБ`,
    megabytes: (n) => `${n} МБ`,
  },
);

/** Types the browser may show in a tab, chosen by the file's extension; the declared type is never trusted. */
const VIEWABLE: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  txt: "text/plain;charset=utf-8",
  csv: "text/plain;charset=utf-8",
  log: "text/plain;charset=utf-8",
  md: "text/plain;charset=utf-8",
  json: "text/plain;charset=utf-8",
};

export function viewableType(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return VIEWABLE[ext] ?? null;
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export function Attachments({ rpc, hostId, messageRef, attachments }: { rpc: Rpc; hostId: string; messageRef: string; attachments: readonly MessageAttachment[] }) {
  const t = useMessages(texts);
  const explain = useExplain();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (attachments.length === 0) return null;

  const size = (bytes: number | null) =>
    bytes === null ? "" : bytes < 1024 ? t.bytes(bytes) : bytes < 1048576 ? t.kilobytes(Math.round(bytes / 1024)) : t.megabytes((bytes / 1048576).toFixed(1));

  const fetchFile = (index: number) => rpc.call("attachment", { hostId, ref: messageRef, index });

  const save = async (attachment: MessageAttachment) => {
    setBusy(attachment.index);
    setError(null);
    try {
      const file = await fetchFile(attachment.index);
      // octet-stream: the browser saves it and does not try to show it.
      const url = URL.createObjectURL(new Blob([bytesOf(file.base64)], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const open = async (attachment: MessageAttachment, type: string) => {
    // Opened now, while the click still counts, or the browser blocks the tab.
    const tab = window.open("about:blank", "_blank");
    if (!tab) return save(attachment);
    tab.opener = null;
    setBusy(attachment.index);
    setError(null);
    try {
      const file = await fetchFile(attachment.index);
      const url = URL.createObjectURL(new Blob([bytesOf(file.base64)], { type }));
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    } catch (cause) {
      tab.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t.title}</p>
      <ul className="space-y-1">
        {attachments.map((attachment) => {
          const tooLarge = attachment.size !== null && attachment.size > ATTACHMENT_MAX_BYTES;
          const type = viewableType(attachment.name);
          return (
            <li key={attachment.index} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2 py-1 text-sm">
              <span className="min-w-0 flex-1 break-all">
                {attachment.name}
                {attachment.size !== null ? <span className="text-xs text-muted-foreground"> ({size(attachment.size)})</span> : null}
              </span>
              {attachment.kind !== "file" ? (
                <span className="text-xs text-muted-foreground">{t.inOutlook}</span>
              ) : tooLarge ? (
                <span className="text-xs text-muted-foreground">{t.tooLarge(ATTACHMENT_MAX_BYTES / 1048576)}</span>
              ) : busy === attachment.index ? (
                <span className="text-xs text-muted-foreground">{t.loading}</span>
              ) : (
                <span className="flex gap-1">
                  {type ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void open(attachment, type)}>
                      {t.open}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void save(attachment)}>
                    {t.save}
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <p className="text-xs text-destructive">{explain(error)}</p> : null}
    </div>
  );
}
