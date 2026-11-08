import { useState } from "react";
import { splitPrefix, type Issue } from "../shared/model";
import type { StatusView } from "../server/rpc-contract";
import { Card, ProgressBar } from "./Card";
import { Avatar, Dot, Icons, ParentTrail, StatusPill, TitleText, TypeTile } from "./parts";
import { composition, useView } from "./view";

const RANK = { todo: 0, progress: 1, done: 2 } as const;

/** The columns: configured statuses, then any other status a card is in, by category. */
export function boardColumns(statuses: readonly StatusView[], configured: ReadonlySet<string>, issues: readonly Issue[]): StatusView[] {
  const used = new Set(issues.map((issue) => issue.status));
  return statuses
    .map((status, index) => ({ status, index }))
    .filter(({ status }) => configured.has(status.key) || used.has(status.key))
    .sort((a, b) => (configured.has(a.status.key) && configured.has(b.status.key) ? a.index - b.index : RANK[a.status.category] - RANK[b.status.category] || a.index - b.index))
    .map(({ status }) => status);
}

function Column({ status, items, inLane }: { status: StatusView; items: Issue[]; inLane?: boolean }) {
  const view = useView();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`tb-col${over ? " tb-over" : ""}`}
      onDragOver={(event) => {
        if (!view.config.can.status || !event.dataTransfer.types.includes("application/x-tracker-key")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const key = event.dataTransfer.getData("application/x-tracker-key");
        if (key) {
          event.preventDefault();
          view.drop(key, status.key);
        }
      }}
    >
      {inLane ? null : (
        <div className="tb-col-h">
          <Dot color={view.colors.get(status.key)} />
          <b>{status.name}</b>
          <span className="tb-n">{items.length}</span>
        </div>
      )}
      <div className="tb-col-b">
        {items.map((issue) => (
          <Card key={issue.key} issue={issue} />
        ))}
        {items.length === 0 && !inLane ? <div className="tb-empty">{view.t.dropHere}</div> : null}
      </div>
    </div>
  );
}

interface Lane {
  id: string;
  story?: Issue;
  person?: { id: string; name: string };
  title?: string;
  items: Issue[];
}

export function BoardView({ visible, columns }: { visible: Issue[]; columns: StatusView[] }) {
  const view = useView();
  const { t, display } = view;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const widths = { narrow: 220, normal: 252, wide: 300 };
  const style = { ["--tb-colw" as string]: `${widths[display.width]}px`, ["--tb-cols" as string]: String(Math.max(columns.length, 1)) };
  if (display.group === "none") {
    return (
      <div className="tb-board" style={style}>
        {columns.map((status) => (
          <Column key={status.key} status={status} items={visible.filter((issue) => issue.status === status.key)} />
        ))}
      </div>
    );
  }
  let lanes: Lane[];
  if (display.group === "story") {
    const stories = view.board.issues.filter((issue) => issue.kind === "story");
    const storyKeys = new Set(stories.map((story) => story.key));
    lanes = stories.map((story) => ({ id: story.key, story, items: visible.filter((issue) => issue.parent === story.key) }));
    lanes.push({ id: "_none", title: t.noStory, items: visible.filter((issue) => issue.kind !== "story" && !(issue.parent && storyKeys.has(issue.parent))) });
  } else {
    const people = new Map<string, string>();
    for (const issue of visible) if (issue.assignee) people.set(issue.assignee, issue.assigneeName ?? view.personName(issue.assignee));
    lanes = [...people].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ id, person: { id, name }, items: visible.filter((issue) => issue.assignee === id) }));
    lanes.push({ id: "_none", title: t.noAssignee, items: visible.filter((issue) => !issue.assignee) });
  }
  lanes = lanes.filter((lane) => lane.items.length > 0 || lane.story);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="tb-lanes" style={style}>
      <div className="tb-lane-colh">
        {columns.map((status) => (
          <div key={status.key}>
            <Dot color={view.colors.get(status.key)} />
            {status.name}
          </div>
        ))}
      </div>
      {lanes.map((lane) => {
        const closed = collapsed.has(lane.id);
        return (
          <div className="tb-lane" key={lane.id}>
            <div className="tb-lane-h">
              <button className="tb-ib tb-ib-s" type="button" onClick={() => toggle(lane.id)} aria-label={closed ? t.expand : t.collapse} aria-expanded={!closed}>
                {closed ? <Icons.chevR /> : <Icons.chevD />}
              </button>
              {lane.story ? <StoryLaneTitle story={lane.story} /> : null}
              {lane.person ? (
                <>
                  <Avatar id={lane.person.id} name={lane.person.name} t={t} />
                  <span className="tb-lt">{lane.person.name}</span>
                  <span className="tb-hint">{lane.items.length}</span>
                </>
              ) : null}
              {lane.title ? (
                <>
                  <span className="tb-lt">{lane.title}</span>
                  <span className="tb-hint">{lane.items.length}</span>
                </>
              ) : null}
            </div>
            {closed ? null : (
              <div className="tb-lane-grid">
                {columns.map((status) => (
                  <Column key={status.key} status={status} items={lane.items.filter((issue) => issue.status === status.key)} inLane />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StoryLaneTitle({ story }: { story: Issue }) {
  const view = useView();
  const { t } = view;
  const c = composition(story, view);
  return (
    <>
      <TypeTile kind="story" t={t} />
      <span className="tb-key">{story.key}</span>
      <button className="tb-lt tb-link" type="button" onClick={() => view.open(story.key)}>
        {splitPrefix(story.summary).rest}
      </button>
      <StatusPill name={view.statusName(story.status)} color={view.colors.get(story.status)} />
      <Avatar id={story.assignee} name={story.assigneeName} t={t} />
      <span className="tb-hint">{t.doneOf(c.done, c.total)}</span>
      <span className="tb-lane-bar">
        <ProgressBar issueKey={story.key} />
      </span>
      {c.missing.length > 0 && view.config.can.create ? (
        <button className="tb-btn tb-ghost" type="button" onClick={() => view.addFromTemplates(story.key)}>
          <Icons.plus />
          {t.addMissing(c.missing.map((template) => template.id).join(", "))}
        </button>
      ) : null}
    </>
  );
}

export function ListView({ visible, rootKey }: { visible: Issue[]; rootKey: string | null }) {
  const view = useView();
  const { t, display } = view;
  const has = (field: (typeof display.fields)[number]) => display.fields.includes(field);
  const shown = new Set(visible.map((issue) => issue.key));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const rows: { issue: Issue; depth: number; kids: number }[] = [];
  const placed = new Set<string>();
  const walk = (issue: Issue, depth: number) => {
    if (placed.has(issue.key) || depth > 8) return;
    const kids = view.children.get(issue.key) ?? [];
    const relevant = shown.has(issue.key) || issue.key === rootKey || kids.some((kid) => shown.has(kid.key) || (view.children.get(kid.key) ?? []).some((grand) => shown.has(grand.key)));
    if (!relevant) return;
    placed.add(issue.key);
    rows.push({ issue, depth, kids: kids.length });
    if (!closed.has(issue.key)) for (const kid of kids) walk(kid, depth + 1);
  };
  const tops = view.board.issues.filter((issue) => !issue.parent || !view.byKey.has(issue.parent));
  for (const top of tops) walk(top, 0);
  // Fixed widths: the title takes what is left and cuts with an ellipsis, so a long
  // title never pushes the status and the other columns off the screen.
  const columns = (
    [
      ["priority", t.field_priority, 110],
      ["assignee", t.field_assignee, 170],
      ["labels", t.field_labels, 150],
      ["parent", t.field_parent, 200],
      ["due", t.field_due, 100],
    ] as const
  ).filter(([field]) => has(field));
  const longestKey = rows.reduce((max, row) => Math.max(max, row.issue.key.length), 6);
  const toggle = (key: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <table className="tb-tbl">
      <thead>
        <tr>
          <th style={{ width: 34 }} />
          {has("key") ? <th style={{ width: `calc(${(longestKey * 1.15).toFixed(1)}ch + ${has("type") ? 44 : 22}px)` }}>{t.field_key}</th> : null}
          <th>{t.title}</th>
          <th style={{ width: 170 }}>{t.status}</th>
          {columns.map(([field, name, width]) => (
            <th key={field} style={{ width }}>
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ issue, depth, kids }) => {
          const selected = view.selection.has(issue.key);
          return (
            <tr key={issue.key} className={`tb-row${selected ? " tb-sel" : ""}${view.flash.has(issue.key) ? " tb-flash" : ""}`} onClick={() => view.open(issue.key)}>
              <td onClick={(event) => event.stopPropagation()}>
                <input className="tb-cb" type="checkbox" checked={selected} onChange={() => view.pick(issue.key)} aria-label={t.pick(issue.key)} />
              </td>
              {has("key") ? (
                <td>
                  <span className="tb-tcell">
                    {has("type") ? <TypeTile kind={issue.kind} t={t} /> : null}
                    <span className="tb-key">{issue.key}</span>
                  </span>
                </td>
              ) : null}
              <td>
                <span className="tb-tcell" style={{ paddingLeft: depth * 20 }}>
                  {kids > 0 ? (
                    <button
                      className="tb-tw"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(issue.key);
                      }}
                      aria-label={closed.has(issue.key) ? t.expand : t.collapse}
                      aria-expanded={!closed.has(issue.key)}
                    >
                      {closed.has(issue.key) ? <Icons.chevR /> : <Icons.chevD />}
                    </button>
                  ) : (
                    <span className="tb-tw" />
                  )}
                  <span className="tb-t" title={issue.summary}>
                    <TitleText issue={issue} />
                  </span>
                  {kids > 0 ? (
                    <span className="tb-list-bar">
                      <ProgressBar issueKey={issue.key} />
                    </span>
                  ) : null}
                </span>
              </td>
              <td title={view.statusName(issue.status)}>
                <StatusPill name={view.statusName(issue.status)} color={view.colors.get(issue.status)} />
              </td>
              {columns.map(([field]) => (
                <td key={field}>{listCell(field, issue)}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  function listCell(field: "priority" | "assignee" | "labels" | "parent" | "due", issue: Issue) {
    switch (field) {
      case "priority":
        return <span className="tb-hint">{view.priorityName(issue.priority) ?? issue.priority ?? ""}</span>;
      case "assignee":
        return (
          <span className="tb-tcell">
            <Avatar id={issue.assignee} name={issue.assigneeName} size={20} t={t} />
            <span className="tb-t">{issue.assignee ? issue.assigneeName ?? view.personName(issue.assignee) : t.none}</span>
          </span>
        );
      case "labels":
        return (
          <span className="tb-labels tb-nowrap">
            {issue.labels.slice(0, 1).map((label) => (
              <span key={label} className="tb-lbl">
                {label}
              </span>
            ))}
            {issue.labels.length > 1 ? <span className="tb-lbl">+{issue.labels.length - 1}</span> : null}
          </span>
        );
      case "parent":
        return <ParentTrail issue={issue} byKey={view.chain} t={t} onOpen={view.open} />;
      case "due":
        return <span className="tb-due">{issue.due ? issue.due.slice(0, 10) : ""}</span>;
    }
  }
}
