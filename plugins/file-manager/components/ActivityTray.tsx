// components/ActivityTray.tsx — bottom-right progress stack.
//
// Two kinds of work land here: chunked uploads (client-driven, byte-accurate
// via XHR progress) and server-side extract jobs (§4 `jobSchema`). The tray is
// `pointer-events-none` so it never eats a drop aimed at the table behind it;
// only the card itself takes pointer events (§9).
import type { Job } from "../contract";
import type { UploadState } from "../lib/upload-manager";
import { cn } from "../lib/utils";
import { formatBytes, formatEta, formatPercent, formatSpeed, progressRatio } from "../lib/format";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { describeErrorCode } from "../lib/errors";
import { defineMessages, messagesNow, pluralRu, useMessages } from "../lib/i18n";

const messages = defineMessages(
  {
    failed: "Failed",
    retry: (name: string) => `Retry ${name}`,
    dismiss: (name: string) => `Dismiss ${name}`,
    cancel: (name: string) => `Cancel ${name}`,
    uploadFailed: "Upload failed",
    queued: "Queued",
    finishing: "Finishing…",
    paused: "Paused",
    uploading: (count: number) => `Uploading ${String(count)} file${count === 1 ? "" : "s"}`,
    activity: "Activity",
    clear: "Clear",
    extracting: (name: string) => `Extracting "${name}"`,
    jobFinished: (label: string) => `${label} finished`,
    jobFailed: (label: string) => `${label} failed`,
  },
  {
    failed: "Ошибка",
    retry: (name) => `Повторить ${name}`,
    dismiss: (name) => `Убрать ${name}`,
    cancel: (name) => `Отменить ${name}`,
    uploadFailed: "Не удалось загрузить",
    queued: "В очереди",
    finishing: "Завершение…",
    paused: "Пауза",
    uploading: (count) =>
      `${pluralRu(count, ["Загружается", "Загружаются", "Загружаются"])} ${String(count)} ${pluralRu(count, ["файл", "файла", "файлов"])}`,
    activity: "Активность",
    clear: "Очистить",
    extracting: (name) => `Распаковка «${name}»`,
    jobFinished: (label) => `${label}: готово`,
    jobFailed: (label) => `${label}: не удалось`,
  },
);

/** A job's label in the interface language; the server's own label is English. */
export function jobLabel(job: Job): string {
  const t = messagesNow(messages);
  if (job.kind === "extract" && job.subject !== "") return t.extracting(job.subject);
  return job.label;
}

/** Toast text for a job that just settled. */
export function jobSettledText(job: Job): string {
  const t = messagesNow(messages);
  const label = jobLabel(job);
  if (job.state === "done") return t.jobFinished(label);
  if (job.errorCode === null) return job.errorMessage ?? t.jobFailed(label);
  // "Extraction failed" would only repeat the label.
  if (job.errorCode === "archive_failed") return t.jobFailed(label);
  return `${t.jobFailed(label)}. ${describeErrorCode(job.errorCode)}`;
}

export interface ActivityTrayProps {
  uploads: readonly UploadState[];
  jobs: readonly Job[];
  onCancelUpload: (id: string) => void;
  onRetryUpload: (id: string) => void;
  onDismissUpload: (id: string) => void;
  onClearFinished: () => void;
  onCancelJob: (jobId: string) => void;
  onDismissJob: (jobId: string) => void;
  className?: string;
}

function ProgressBar({ ratio, tone }: { ratio: number; tone: "primary" | "destructive" }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-recessed">
      <div
        data-testid="fm-progress-bar"
        className={cn(
          "h-full rounded-full transition-[width] duration-150",
          tone === "destructive" ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${String(Math.round(ratio * 100))}%` }}
      />
    </div>
  );
}

function uploadIcon(status: UploadState["status"]): IconName {
  switch (status) {
    case "done":
      return "Check";
    case "error":
      return "AlertTriangle";
    case "canceled":
      return "X";
    case "paused":
      return "Pause";
    default:
      return "PackageReceive";
  }
}

function UploadRow({
  upload,
  onCancel,
  onRetry,
  onDismiss,
}: {
  upload: UploadState;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const t = useMessages(messages);
  const ratio = progressRatio(upload.sentBytes, upload.sizeBytes);
  const settled = upload.status === "done" || upload.status === "canceled";
  const failed = upload.status === "error";

  return (
    <li data-testid="fm-upload-item" data-upload-status={upload.status} className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          name={uploadIcon(upload.status)}
          className={cn(
            "size-4 shrink-0",
            upload.status === "done" && "text-success",
            failed && "text-destructive",
            !failed && upload.status !== "done" && "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs" title={upload.fileName}>
          {upload.fileName}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {failed ? t.failed : settled ? formatBytes(upload.sizeBytes) : formatPercent(ratio)}
        </span>
        {settled || failed ? (
          <>
            {failed ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 p-0"
                aria-label={t.retry(upload.fileName)}
                onClick={() => onRetry(upload.id)}
              >
                <Icon name="ArrowReloadHorizontal" className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-6 p-0"
              aria-label={t.dismiss(upload.fileName)}
              onClick={() => onDismiss(upload.id)}
            >
              <Icon name="X" className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-6 p-0"
            aria-label={t.cancel(upload.fileName)}
            onClick={() => onCancel(upload.id)}
          >
            <Icon name="X" className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {settled ? null : (
        <div className="mt-1.5 space-y-1">
          <ProgressBar ratio={ratio} tone={failed ? "destructive" : "primary"} />
          <p className="flex items-center gap-2 text-[0.6875rem] tabular-nums text-muted-foreground">
            {failed ? (
              <span className="truncate text-destructive">
                {upload.errorMessage ?? t.uploadFailed}
              </span>
            ) : (
              <>
                <span>
                  {formatBytes(upload.sentBytes)} / {formatBytes(upload.sizeBytes)}
                </span>
                {upload.status === "uploading" && upload.bytesPerSecond > 0 ? (
                  <span>{formatSpeed(upload.bytesPerSecond)}</span>
                ) : null}
                {upload.status === "uploading" ? <span>{formatEta(upload.etaMs)}</span> : null}
                {upload.status === "queued" ? <span>{t.queued}</span> : null}
                {upload.status === "finishing" ? <span>{t.finishing}</span> : null}
                {upload.status === "paused" ? <span>{t.paused}</span> : null}
              </>
            )}
          </p>
        </div>
      )}
    </li>
  );
}

function JobRow({
  job,
  onCancel,
  onDismiss,
}: {
  job: Job;
  onCancel: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
}) {
  const t = useMessages(messages);
  const running = job.state === "running";
  const ratio = progressRatio(job.processedBytes, job.totalBytes);
  const label = jobLabel(job);
  // The code's sentence is in the interface language; the server's detail
  // (tool output, exit codes) stays in the tooltip.
  const failure =
    job.errorCode === null ? job.errorMessage : describeErrorCode(job.errorCode);

  return (
    <li data-testid="fm-job-item" data-job-state={job.state} className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          name={job.state === "failed" ? "AlertTriangle" : "ArchiveRestore"}
          className={cn(
            "size-4 shrink-0",
            job.state === "done" && "text-success",
            job.state === "failed" && "text-destructive",
            running && "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs" title={label}>
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-6 p-0"
          aria-label={running ? t.cancel(label) : t.dismiss(label)}
          onClick={() => (running ? onCancel(job.jobId) : onDismiss(job.jobId))}
        >
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {running ? (
        <div className="mt-1.5">
          {job.totalBytes > 0 ? (
            <ProgressBar ratio={ratio} tone="primary" />
          ) : (
            <div className="h-1 w-full overflow-hidden rounded-full bg-surface-recessed">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          )}
        </div>
      ) : null}
      {job.state === "failed" && failure !== null ? (
        <p
          className="mt-1 truncate text-[0.6875rem] text-destructive"
          title={job.errorMessage ?? undefined}
        >
          {failure}
        </p>
      ) : null}
    </li>
  );
}

export function ActivityTray({
  uploads,
  jobs,
  onCancelUpload,
  onRetryUpload,
  onDismissUpload,
  onClearFinished,
  onCancelJob,
  onDismissJob,
  className,
}: ActivityTrayProps) {
  const t = useMessages(messages);
  if (uploads.length === 0 && jobs.length === 0) return null;

  const activeUploads = uploads.filter(
    (upload) =>
      upload.status !== "done" && upload.status !== "canceled" && upload.status !== "error",
  ).length;
  const finished = uploads.length - activeUploads;

  return (
    <div
      data-testid="fm-activity-tray"
      // `max-w` matters in a panel tab: the tray is fixed at 320px, and a
      // narrow side panel would otherwise let it hang over both edges.
      className={cn(
        "pointer-events-none absolute bottom-3 right-3 z-20 w-80 max-w-[calc(100%-1.5rem)]",
        className,
      )}
    >
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md">
        <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-1.5">
          <span className="flex-1 text-xs font-medium">
            {activeUploads > 0 ? t.uploading(activeUploads) : t.activity}
          </span>
          {finished > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onClearFinished}
            >
              {t.clear}
            </Button>
          ) : null}
        </div>
        <ul className="max-h-64 divide-y divide-border-hairline overflow-y-auto">
          {uploads.map((upload) => (
            <UploadRow
              key={upload.id}
              upload={upload}
              onCancel={onCancelUpload}
              onRetry={onRetryUpload}
              onDismiss={onDismissUpload}
            />
          ))}
          {jobs.map((job) => (
            <JobRow key={job.jobId} job={job} onCancel={onCancelJob} onDismiss={onDismissJob} />
          ))}
        </ul>
      </div>
    </div>
  );
}
