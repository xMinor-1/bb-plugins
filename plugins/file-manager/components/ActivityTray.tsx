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
          {failed ? "Failed" : settled ? formatBytes(upload.sizeBytes) : formatPercent(ratio)}
        </span>
        {settled || failed ? (
          <>
            {failed ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 p-0"
                aria-label={`Retry ${upload.fileName}`}
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
              aria-label={`Dismiss ${upload.fileName}`}
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
            aria-label={`Cancel ${upload.fileName}`}
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
                {upload.errorMessage ?? "Upload failed"}
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
                {upload.status === "queued" ? <span>Queued</span> : null}
                {upload.status === "finishing" ? <span>Finishing…</span> : null}
                {upload.status === "paused" ? <span>Paused</span> : null}
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
  const running = job.state === "running";
  const ratio = progressRatio(job.processedBytes, job.totalBytes);

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
        <span className="min-w-0 flex-1 truncate text-xs" title={job.label}>
          {job.label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-6 p-0"
          aria-label={running ? `Cancel ${job.label}` : `Dismiss ${job.label}`}
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
      {job.state === "failed" && job.errorMessage !== null ? (
        <p className="mt-1 truncate text-[0.6875rem] text-destructive">{job.errorMessage}</p>
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
  if (uploads.length === 0 && jobs.length === 0) return null;

  const activeUploads = uploads.filter(
    (upload) =>
      upload.status !== "done" && upload.status !== "canceled" && upload.status !== "error",
  ).length;
  const finished = uploads.length - activeUploads;

  return (
    <div
      data-testid="fm-activity-tray"
      className={cn("pointer-events-none absolute bottom-3 right-3 z-20 w-80", className)}
    >
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md">
        <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-1.5">
          <span className="flex-1 text-xs font-medium">
            {activeUploads > 0
              ? `Uploading ${String(activeUploads)} file${activeUploads === 1 ? "" : "s"}`
              : "Activity"}
          </span>
          {finished > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onClearFinished}
            >
              Clear
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
