// Small layout pieces shared by the panel sections.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({ step, title, children, muted }: { step: number; title: string; children: ReactNode; muted?: boolean }) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-4", muted && "opacity-60")}>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">{step}</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "error" | "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "ok" && "border-border text-foreground",
        tone === "error" && "border-destructive/50 text-destructive",
        tone === "warn" && "border-border bg-muted/40 text-foreground",
        tone === "info" && "border-dashed border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
