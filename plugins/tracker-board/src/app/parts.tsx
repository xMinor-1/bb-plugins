// Small pieces every view uses: icons, the type tile, status dots, avatars.
import type { ReactNode } from "react";
import { ancestors, splitPrefix, type Issue, type Kind } from "../shared/model";
import type { StatusView } from "../server/rpc-contract";
import type { Messages } from "./messages";

const svg = (size: number, children: ReactNode, strokeWidth = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icons = {
  search: () => svg(14, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, 2),
  refresh: () => svg(15, <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>),
  gear: () => svg(15, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>),
  x: () => svg(14, <path d="M18 6 6 18M6 6l12 12" />, 2),
  expand: () => svg(14, <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />, 2),
  ext: () => svg(13, <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />, 2),
  link: () => svg(13, <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />, 2),
  chevR: () => svg(12, <path d="m9 6 6 6-6 6" />, 2.4),
  chevD: () => svg(12, <path d="m6 9 6 6 6-6" />, 2.4),
  check: () => svg(11, <path d="m5 12 5 5 9-10" />, 3.5),
  plus: () => svg(13, <path d="M12 5v14M5 12h14" />, 2.2),
  chat: () => svg(15, <path d="M4 6h12a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H9l-4 3v-3H4" />),
  sliders: () => svg(15, <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>),
  lock: () => svg(11, <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 2),
  board: () => svg(16, <><rect x="3.5" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="16.5" y="4" width="4" height="7" rx="1.5" /></>),
  list: () => svg(15, <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />, 2.2),
  comment: () => svg(13, <path d="M4 6h12a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H9l-4 3v-3H4" />, 2),
};

const KIND_PATH: Record<Kind, ReactNode> = {
  epic: <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none" />,
  story: <path d="M6 2h12v20l-6-5-6 5z" fill="currentColor" stroke="none" />,
  task: <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none" />,
  bug: <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />,
};

export function TypeTile({ kind, t, small }: { kind: Kind; t: Messages; small?: boolean }) {
  return (
    <span className={`tb-ty tb-ty-${kind}${small ? " tb-ty-s" : ""}`} title={t[`type_${kind}`]} aria-label={t[`type_${kind}`]}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {KIND_PATH[kind]}
      </svg>
    </span>
  );
}

const PROGRESS_COLORS = ["var(--tb-st-ready)", "var(--tb-st-dev)", "var(--tb-st-review)", "var(--tb-st-test)"];

/** A colour per status: grey for to-do, green for done, the progress ones in turn. */
export function statusColors(statuses: readonly StatusView[]): Map<string, string> {
  const out = new Map<string, string>();
  let progress = 0;
  for (const status of statuses) {
    if (status.category === "todo") out.set(status.key, "var(--tb-st-open)");
    else if (status.category === "done") out.set(status.key, "var(--tb-st-done)");
    else out.set(status.key, PROGRESS_COLORS[progress++ % PROGRESS_COLORS.length]!);
  }
  return out;
}

export function Dot({ color }: { color: string | undefined }) {
  return <span className="tb-dot" style={{ background: color ?? "var(--tb-st-open)" }} aria-hidden="true" />;
}

export function StatusPill({ name, color }: { name: string; color: string | undefined }) {
  return (
    <span className="tb-pill">
      <Dot color={color} />
      {name}
    </span>
  );
}

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function initials(name: string): string {
  const words = name.split(/[\s.@_-]+/).filter((word) => word !== "");
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

export function Avatar({ id, name, size, t }: { id: string | null; name: string | null; size?: number; t: Messages }) {
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined;
  if (!id) {
    return (
      <span className="tb-ava tb-ava-none" style={style} title={t.noAssignee}>
        ?
      </span>
    );
  }
  const label = name ?? id;
  return (
    <span className="tb-ava" style={{ ...style, background: `oklch(54% 0.11 ${hue(id)})` }} title={label}>
      {initials(label)}
    </span>
  );
}

const PRIORITY_RANK = ["blocker", "critical", "highest", "high", "major", "medium", "normal", "minor", "low", "lowest", "trivial"];

export function Priority({ value, name, t }: { value: string | null; name?: string; t: Messages }) {
  if (!value) return null;
  const rank = PRIORITY_RANK.indexOf(value.toLowerCase());
  const level = rank < 0 ? 2 : rank <= 1 ? 0 : rank <= 4 ? 1 : rank <= 6 ? 2 : rank <= 9 ? 3 : 4;
  const paths = ["M6 15l6-6 6 6M6 10l6-6 6 6", "M6 14l6-6 6 6", "M6 10h12M6 15h12", "M6 10l6 6 6-6", "M6 8l6 6 6-6M6 13l6 6 6-6"];
  const colors = ["var(--tb-danger)", "var(--tb-st-dev)", "var(--tb-faint)", "var(--tb-st-ready)", "var(--tb-faint)"];
  return (
    <span className="tb-prio" title={`${t.priority}: ${name ?? value}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors[level]} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={paths[level]} />
      </svg>
    </span>
  );
}

export function TitleText({ issue }: { issue: Pick<Issue, "summary"> }) {
  const summary = issue.summary;
  if (!summary.startsWith("[")) return <>{summary}</>;
  const end = summary.indexOf("]");
  const prefix = end > 1 && end < 10 ? summary.slice(1, end) : "";
  if (!/^[A-Za-z0-9]+$/.test(prefix)) return <>{summary}</>;
  return (
    <>
      <span className="tb-pfx">{prefix}</span>
      {summary.slice(end + 1).trimStart()}
    </>
  );
}

export function formatDate(value: string | null, locale: string): string {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, { day: "numeric", month: "short" }).replace(".", "");
}

export function isLate(issue: Issue, today: string): boolean {
  return Boolean(issue.due && issue.due.slice(0, 10) < today && issue.category !== "done");
}

export function todayText(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const EPIC_HUES = [250, 25, 145, 300, 200, 60, 330, 95];

/** A colour that stays with an epic: from its key, so every board and card agree. */
export function epicHue(key: string): number {
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return EPIC_HUES[hash % EPIC_HUES.length]!;
}

export function EpicTag({ epic, t, onOpen }: { epic: Issue; t: Messages; onOpen: (key: string) => void }) {
  const title = splitPrefix(epic.summary).rest;
  return (
    <button
      className="tb-etag"
      type="button"
      style={{ ["--tb-eh" as string]: `oklch(62% 0.14 ${epicHue(epic.key)})` }}
      title={t.epicTag(epic.key, title)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(epic.key);
      }}
    >
      <span>{title}</span>
    </button>
  );
}

/** Epic › story › …: every parent with its title, each opens on click. */
export function ParentPath({ issue, byKey, t, onOpen }: { issue: Issue; byKey: ReadonlyMap<string, Issue>; t: Messages; onOpen: (key: string) => void }) {
  const up = ancestors(issue, byKey);
  if (up.length === 0) return issue.parent ? <span className="tb-key">{issue.parent}</span> : null;
  return (
    <span className="tb-chain">
      {up.map((parent, index) => (
        <span key={parent.key} className="tb-chain-i">
          {index > 0 ? <span className="tb-chs">›</span> : null}
          <button
            className="tb-chn"
            type="button"
            title={`${parent.key} ${parent.summary}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(parent.key);
            }}
          >
            <TypeTile kind={parent.kind} t={t} small />
            <span>{splitPrefix(parent.summary).rest}</span>
          </button>
        </span>
      ))}
    </span>
  );
}
