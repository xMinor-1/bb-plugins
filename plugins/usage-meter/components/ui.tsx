// components/ui.tsx — the handful of pieces the Usage page is built from.
//
// No component library: the page is a stack of tables and bars, and every
// colour here is a host theme token (or a default Tailwind utility), so the
// page follows whatever theme bb is wearing.
import type { ReactNode } from "react";

import { DANGER, WARN } from "../lib/limits";

/** How alarming a percentage is. The thresholds are the rings' own. */
export type Tone = "normal" | "warn" | "danger";

export function toneOf(percent: number | null): Tone {
  if (percent === null) return "normal";
  if (percent > DANGER) return "danger";
  if (percent >= WARN) return "warn";
  return "normal";
}

const BAR_TONE: Record<Tone, string> = {
  normal: "bg-foreground/55",
  warn: "bg-amber-500",
  danger: "bg-destructive",
};

const TEXT_TONE: Record<Tone, string> = {
  normal: "text-foreground",
  warn: "text-amber-500",
  danger: "text-destructive",
};

/** One boxed section. `hint` is the small print under the heading. */
export function Card({
  title,
  hint,
  right,
  children,
}: {
  title?: string;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-border bg-card">
      {title === undefined && right === undefined ? null : (
        <header className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            {title === undefined ? null : (
              <h2 className="text-sm font-medium text-foreground">{title}</h2>
            )}
            {hint === undefined ? null : (
              <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
            )}
          </div>
          {right === undefined ? null : <div className="flex-none">{right}</div>}
        </header>
      )}
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

/** A proportional bar. `value` is a percentage, 0..100. */
export function Meter({
  value,
  tone = "normal",
  className = "",
}: {
  value: number;
  tone?: Tone;
  className?: string;
}): ReactNode {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${className}`}>
      <div
        className={`h-full rounded-full ${BAR_TONE[tone]}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/** A percentage in the tone of its own value. */
export function Percent({
  value,
  tone = "normal",
}: {
  value: string;
  tone?: Tone;
}): ReactNode {
  return <span className={`tabular-nums ${TEXT_TONE[tone]}`}>{value}</span>;
}

/** A figure with a caption under it — the row of numbers above a table. */
export function Stat({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}): ReactNode {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-base tabular-nums text-foreground">{value}</div>
      {hint === undefined ? null : (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

/**
 * A plain table; the header row is the only chrome it gets.
 *
 * Column widths belong here, on the header, and nowhere else: with
 * `table-layout: fixed` the browser takes the widths from the FIRST row of the
 * table and ignores every width further down, so the same numbers written on
 * the body cells would quietly do nothing and leave five equal columns.
 *
 * They are percentages, and the name column is left without one so it takes
 * whatever is over. Widths in rem are what makes a name column vanish inside a
 * narrow panel: once they add up to more than the table there is nothing left.
 */
export function Table({
  head,
  widths,
  children,
}: {
  head: ReactNode[];
  /** One entry per column; `undefined` lets the column take the rest. */
  widths?: Array<string | undefined>;
  children: ReactNode;
}): ReactNode {
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b border-border">
          {head.map((cell, index) => (
            <th
              key={index}
              style={widths?.[index] === undefined ? undefined : { width: widths[index] }}
              className={`py-1.5 text-xs font-normal text-muted-foreground ${
                index === 0 ? "text-left" : "text-right"
              }`}
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * A cell. Everything but the first column is right-aligned and tabular. Every
 * cell clips: the tables are `table-fixed`, and a value wider than its column
 * would otherwise spill over the neighbouring one instead of being cut. The
 * column widths live on the header — see `Table`.
 */
export function Cell({
  children,
  first = false,
  muted = false,
  title,
}: {
  children: ReactNode;
  first?: boolean;
  muted?: boolean;
  title?: string;
}): ReactNode {
  return (
    <td
      className={`truncate py-1.5 align-middle ${first ? "text-left" : "text-right tabular-nums"} ${
        muted ? "text-muted-foreground" : "text-foreground"
      } ${first ? "pr-2" : "pl-2"}`}
      title={title}
    >
      {children}
    </td>
  );
}

/** The quiet line a section shows instead of a table when it has nothing. */
export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="py-1 text-sm text-muted-foreground">{children}</p>;
}

/** Small print: disclaimers, footnotes, the age of the figures. */
export function Caption({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}
