// A task's parents, first thing in the side panel: the epic, the story, then this task,
// one per row with a line down the left. Every parent shows its type, key, status and
// title; a story its composition row, an epic how much is done. A click opens it. A
// parent from another board looks the same: its tasks load from the tracker.
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { splitPrefix, type Issue } from "../shared/model";
import type { Template } from "../shared/templates";
import type { StatusView } from "../server/rpc-contract";
import { CompositionRow } from "./Card";
import type { Messages } from "./messages";
import { StatusPill, TypeTile } from "./parts";
import type { Rpc } from "./store";
import { composition } from "./view";

const TREE_TTL_MS = 2 * 60_000;
const trees = new Map<string, { at: number; issues: Promise<Issue[]>; keys: Set<string> | null }>();

/** The keys a change signal names; null when it names none, and then anything may have changed. */
function changedKeys(payload: unknown): Set<string> | null {
  const keys = payload && typeof payload === "object" ? (payload as { keys?: unknown }).keys : null;
  return Array.isArray(keys) ? new Set(keys.filter((key): key is string => typeof key === "string")) : null;
}

const touches = (keys: ReadonlySet<string> | null, changed: ReadonlySet<string> | null) => !keys || !changed || [...changed].some((key) => keys.has(key));

/**
 * An issue with everything under it, for parents that are not on the board in view.
 * Kept two minutes, and read again when a task in it changes.
 */
export function useTree(rpc: Rpc, key: string | null, enabled: boolean): { issues: Issue[] | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; issues: Issue[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // bb may keep the first handler: it reads the tree in view through a ref.
  const shown = useRef<Issue[] | null>(null);
  shown.current = state?.key === key ? state.issues : null;
  useRealtime("changed", (payload) => {
    const changed = changedKeys(payload);
    for (const [root, entry] of trees) if (touches(entry.keys, changed)) trees.delete(root);
    const mine = shown.current;
    if (mine && touches(new Set(mine.map((item) => item.key)), changed)) setRound((n) => n + 1);
  });
  useEffect(() => {
    if (!key || !enabled) return;
    let live = true;
    let hit = trees.get(key);
    if (!hit || Date.now() - hit.at > TREE_TTL_MS) {
      const entry: { at: number; issues: Promise<Issue[]>; keys: Set<string> | null } = { at: Date.now(), issues: rpc.call("tree", { key }).then((tree) => tree.issues), keys: null };
      entry.issues.then(
        (issues) => (entry.keys = new Set(issues.map((item) => item.key))),
        () => trees.get(key) === entry && trees.delete(key),
      );
      trees.set(key, entry);
      hit = entry;
    }
    hit.issues.then(
      (issues) => live && setState({ key, issues }),
      () => live && setFailed(key),
    );
    return () => {
      live = false;
    };
  }, [rpc, key, enabled, round]);
  const issues = state?.key === key ? state.issues : null;
  return { issues, loading: Boolean(key && enabled && !issues && failed !== key) };
}

/** Everything under an issue, at any depth. */
export function descendants(key: string, children: ReadonlyMap<string, readonly Issue[]>): Issue[] {
  const out: Issue[] = [];
  const seen = new Set([key]);
  const walk = (parent: string) => {
    for (const kid of children.get(parent) ?? []) {
      if (seen.has(kid.key)) continue;
      seen.add(kid.key);
      out.push(kid);
      walk(kid.key);
    }
  };
  walk(key);
  return out;
}

/** An epic's progress: done of all its tasks, and a bar coloured by status. */
export function EpicProgress({ t, issues, statuses, colors }: { t: Messages; issues: readonly Issue[]; statuses: readonly StatusView[]; colors: ReadonlyMap<string, string> }) {
  if (issues.length === 0) return <div className="tb-prog tb-prog-none">{t.noTasksYet}</div>;
  const done = issues.filter((issue) => issue.category === "done").length;
  const listed = new Set(statuses.map((status) => status.key));
  const rest = issues.filter((issue) => !listed.has(issue.status)).length;
  return (
    <div className="tb-prog">
      <span>{t.doneOf(done, issues.length)}</span>
      <span className="tb-prog-bar">
        {statuses.map((status) => {
          const n = issues.filter((issue) => issue.status === status.key).length;
          return n ? <i key={status.key} style={{ width: `${(n / issues.length) * 100}%`, background: colors.get(status.key) }} title={`${status.name}: ${n}`} /> : null;
        })}
        {rest ? <i style={{ width: `${(rest / issues.length) * 100}%` }} /> : null}
      </span>
    </div>
  );
}

export interface PathData {
  t: Messages;
  /** Children by parent, of the top parent's whole tree; null while it loads. */
  children: ReadonlyMap<string, readonly Issue[]> | null;
  loading: boolean;
  parts: Template[];
  statuses: readonly StatusView[];
  colors: ReadonlyMap<string, string>;
  statusName(key: string): string;
}

/** Under a story its composition, under an epic its progress; a quiet bar while they load. */
export function ParentExtra({ issue, data }: { issue: Issue; data: PathData }) {
  if (issue.kind !== "story" && issue.kind !== "epic") return null;
  if (!data.children) return data.loading ? <div className="tb-pp-wait" aria-hidden="true" /> : null;
  if (issue.kind === "story") {
    return <CompositionRow t={data.t} c={composition(issue, { children: data.children as Map<string, Issue[]>, parts: data.parts })} statusName={data.statusName} />;
  }
  return <EpicProgress t={data.t} issues={descendants(issue.key, data.children)} statuses={data.statuses} colors={data.colors} />;
}

function Row({ issue, data, me, onOpen, children }: { issue: Issue; data: PathData; me?: boolean; onOpen?: (key: string) => void; children?: ReactNode }) {
  const { t } = data;
  const open = onOpen ? () => onOpen(issue.key) : undefined;
  const key = (event: KeyboardEvent) => {
    if (!open || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    open();
  };
  return (
    <div
      className={`tb-pp-row${me ? " tb-pp-me" : ""}`}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      title={open ? t.openParent(issue.key) : undefined}
      onClick={open}
      onKeyDown={key}
    >
      <div className="tb-pp-l">
        <TypeTile kind={issue.kind} t={t} />
      </div>
      <div className="tb-pp-r">
        <div className="tb-pp-h">
          <span className="tb-pp-kind">{me ? t.thisTask : t[`type_${issue.kind}`]}</span>
          <span className="tb-key">{issue.key}</span>
          {me ? null : <StatusPill name={issue.statusName ?? data.statusName(issue.status)} color={data.colors.get(issue.status)} />}
        </div>
        {children}
      </div>
    </div>
  );
}

export function ParentPath({ issue, chain, data, onOpen }: { issue: Issue; chain: readonly Issue[]; data: PathData; onOpen: (key: string) => void }) {
  if (chain.length === 0) return null;
  return (
    <nav className="tb-pp" aria-label={data.t.parentsLabel}>
      {chain.map((parent) => (
        <Row key={parent.key} issue={parent} data={data} onOpen={onOpen}>
          <div className="tb-pp-t">{splitPrefix(parent.summary).rest}</div>
          <ParentExtra issue={parent} data={data} />
        </Row>
      ))}
      <Row issue={issue} data={data} me />
    </nav>
  );
}
