import { epicAbove, type Issue } from "../shared/model";
import { templateOfIssue } from "../shared/templates";
import { Avatar, EpicTag, formatDate, Icons, isLate, Priority, TitleText, TypeTile } from "./parts";
import type { Messages } from "./messages";
import { composition, useView, type RoleCount } from "./view";

function plain(text: string | null): string {
  if (!text) return "";
  // Markup is not rendered on a card: tags, markdown marks and spaces fold into one line.
  let out = "";
  let inTag = false;
  for (const char of text.slice(0, 1200)) {
    if (char === "<") inTag = true;
    else if (char === ">" && inTag) {
      inTag = false;
      out += " ";
    } else if (!inTag) out += char;
  }
  return out.replace(/[#*_`>|~]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

const LISTED = 12;

/** A cell's hover text: the counts in words, then the tasks themselves. */
function cellTitle(head: string, count: RoleCount, statusName: (key: string) => string, t: Messages): string {
  const lines = count.issues.slice(0, LISTED).map((issue) => `${issue.key} ${issue.summary}: ${statusName(issue.status)}`);
  if (count.issues.length > LISTED) lines.push(t.andMore(count.issues.length - LISTED));
  return [head, ...lines].join("\n");
}

function RoleCell({ t, label, count, head, other, statusName }: { t: Messages; label: string; count: RoleCount; head: string; other?: boolean; statusName: (key: string) => string }) {
  const state = count.total === 0 ? "none" : count.done === count.total ? "done" : "work";
  return (
    <span className={`tb-tile tb-tile-${state}${other ? " tb-tile-other" : ""}`} title={cellTitle(head, count, statusName, t)}>
      <b>{label}</b>
      <i>{count.total > 0 ? `${count.done}/${count.total}` : "–"}</i>
    </span>
  );
}

/**
 * A story's composition: one cell per template part and one for the rest, each with
 * done of total. The row has a fixed number of cells, so every card keeps its size
 * however many tasks a story has. The task panel shows the same row for a parent story.
 */
export function CompositionRow({ t, c, statusName }: { t: Messages; c: ReturnType<typeof composition>; statusName: (key: string) => string }) {
  if (c.parts.length === 0 && c.total === 0) return null;
  return (
    <div className="tb-comp">
      <div className="tb-comp-row" style={{ gridTemplateColumns: `repeat(${c.parts.length}, minmax(0, 1fr)) minmax(0, 1.45fr)` }}>
        {c.parts.map((part) => (
          <RoleCell key={part.template.id} t={t} statusName={statusName} label={part.template.id} count={part} head={part.total > 0 ? t.roleDone(part.template.title, part.done, part.total) : t.noTaskYet(part.template.title)} />
        ))}
        <RoleCell t={t} statusName={statusName} label={t.otherShort} count={c.other} head={c.other.total > 0 ? t.roleDone(t.otherTasksTitle, c.other.done, c.other.total) : t.noOtherTasks} other />
      </div>
      <div className="tb-comp-cap">
        <span>{t.doneOf(c.done, c.total)}</span>
      </div>
    </div>
  );
}

export function Composition({ story }: { story: Issue }) {
  const view = useView();
  return <CompositionRow t={view.t} c={composition(story, view)} statusName={view.statusName} />;
}

export function ProgressBar({ issueKey }: { issueKey: string }) {
  const view = useView();
  const kids = view.children.get(issueKey) ?? [];
  if (kids.length === 0) return null;
  return (
    <div className="tb-bar" title={view.t.children}>
      {view.statuses.map((status) => {
        const n = kids.filter((kid) => kid.status === status.key).length;
        return n ? <i key={status.key} style={{ width: `${(n / kids.length) * 100}%`, background: view.colors.get(status.key) }} /> : null;
      })}
    </div>
  );
}

export function Card({ issue }: { issue: Issue }) {
  const view = useView();
  const { t, display } = view;
  const has = (field: (typeof display.fields)[number]) => display.fields.includes(field);
  const selected = view.selection.has(issue.key);
  // On a card only the epic, as a tag; the full path is in the issue panel and the list.
  const epic = has("parent") && issue.kind !== "epic" ? epicAbove(issue, view.chain) : undefined;
  const late = isLate(issue, view.today);
  const labels = has("labels") ? issue.labels : [];
  const template = has("components") ? templateOfIssue(issue, view.templates) : null;
  const components = has("components") ? (issue.components.length > 0 ? issue.components : template?.components ?? []) : [];
  const text = has("description") && issue.kind !== "story" ? plain(issue.description) : "";
  const top = has("type") || has("key") || has("priority");
  const classes = ["tb-card", selected ? "tb-sel" : "", view.flash.has(issue.key) ? "tb-flash" : "", view.openKey === issue.key ? "tb-opened" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      draggable={view.config.can.status}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-tracker-key", issue.key);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) view.pick(issue.key);
        else view.open(issue.key);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") view.open(issue.key);
        if (event.key === " ") {
          event.preventDefault();
          view.pick(issue.key);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${issue.key} ${issue.summary}`}
      style={{ ["--tb-clamp" as string]: String(display.clamp) }}
    >
      <div className={`tb-c-top${top ? "" : " tb-c-top-empty"}`}>
        <button
          className="tb-pick"
          type="button"
          aria-label={t.pick(issue.key)}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            view.pick(issue.key);
          }}
        >
          {selected ? <Icons.check /> : null}
        </button>
        {has("type") ? <TypeTile kind={issue.kind} t={t} /> : null}
        {has("key") ? <span className="tb-key">{issue.key}</span> : null}
        <span className="tb-grow" />
        {has("priority") ? <Priority value={issue.priority} name={view.priorityName(issue.priority)} t={t} /> : null}
      </div>
      {epic && epic.key !== view.board.root?.key ? (
        <div className="tb-c-epic">
          <EpicTag epic={epic} t={t} onOpen={view.open} />
        </div>
      ) : epic === null ? (
        <div className="tb-c-epic tb-noepic">{t.noEpic}</div>
      ) : null}
      <div className="tb-c-title">
        <TitleText issue={issue} />
      </div>
      {text ? <div className="tb-c-desc">{text}</div> : null}
      {issue.kind === "story" && has("composition") ? <Composition story={issue} /> : null}
      {labels.length > 0 || components.length > 0 ? (
        <div className="tb-labels">
          {labels.slice(0, 2).map((label) => (
            <span key={label} className="tb-lbl" title={label}>
              {label}
            </span>
          ))}
          {labels.length > 2 ? <span className="tb-lbl">+{labels.length - 2}</span> : null}
          {components.map((component) => (
            <span key={component} className="tb-lbl tb-lbl-comp" title={t.components}>
              {component}
            </span>
          ))}
        </div>
      ) : null}
      {(has("due") && issue.due) || has("assignee") ? (
        <div className="tb-c-meta">
          <span className="tb-grow" />
          {has("due") && issue.due ? (
            <span className={`tb-due${late ? " tb-late" : ""}`} title={t.due}>
              {late ? t.overdue : ""}
              {formatDate(issue.due, view.locale)}
            </span>
          ) : null}
          {has("assignee") ? <Avatar id={issue.assignee} name={issue.assigneeName ?? view.personName(issue.assignee)} t={t} /> : null}
        </div>
      ) : null}
    </div>
  );
}
