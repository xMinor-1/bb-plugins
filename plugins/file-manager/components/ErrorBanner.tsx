// components/ErrorBanner.tsx — inline, dismissible failure surface with Retry.
//
// §8.1: a throw inside a slot component disables the plugin's UI for the whole
// session, so every RPC failure is caught and rendered here instead of being
// allowed to escape. Domain codes are recovered by lib/errors.ts.
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import { parseRpcError } from "../lib/errors";

export interface ErrorBannerProps {
  /** Anything a rejected RPC promise carried. */
  error: unknown;
  /** Optional lead-in, e.g. "Could not open this folder". */
  title?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  /** `warning` keeps the row scannable for recoverable states. */
  tone?: "error" | "warning";
  className?: string;
}

export function ErrorBanner({
  error,
  title,
  onRetry,
  onDismiss,
  tone = "error",
  className,
}: ErrorBannerProps) {
  const parsed = parseRpcError(error);
  const detail = parsed.message === "" ? "Unknown error." : parsed.message;

  return (
    <div
      role="alert"
      data-testid="fm-error-banner"
      data-error-code={parsed.code ?? ""}
      className={cn(
        "flex items-start gap-2 border-b px-3 py-2 text-sm",
        tone === "error"
          ? "border-surface-destructive-border bg-surface-destructive"
          : "border-border bg-surface-attention text-warning-text",
        className,
      )}
    >
      <Icon
        name="AlertTriangle"
        className={cn("mt-0.5 size-4 shrink-0", tone === "error" && "text-destructive")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {title === undefined ? null : (
          <p className={cn("font-medium", tone === "error" && "text-destructive")}>{title}</p>
        )}
        <p className="break-words text-xs text-muted-foreground">{detail}</p>
      </div>
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
      {onDismiss === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 p-0"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <Icon name="X" className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
