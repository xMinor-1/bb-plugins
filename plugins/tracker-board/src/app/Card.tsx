import { splitPrefix, type Issue } from "../shared/model";
import { templateOfIssue } from "../shared/templates";
import { Avatar, formatDate, Icons, isLate, Priority, TitleText, TypeTile } from "./parts";
import { composition, useView } from "./view";

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

const EXTRA_LISTED = 12;

function extraTitle(t: ReturnType<typeof useView>["t"], extra: readonly Issue[], statusName: (key: string) => string): string {
  const lines = extra.slice(0, EXTRA_LISTED).map((issue) => `${issue.key} ${issue.summary}: ${statusName(issue.status)}`);
  if (extra.length > EXTRA_LISTED) lines.push(t.andMore(extra.length - EXTRA_LISTED));
  return [t.otherTasks(extra.length), ...lines].join("\n");
}

export function Composition({ story }: { story: Issue }) {
  const view = useView();
  const { t } = view;
  const c = composition(story, view);
  if (c.parts.length === 0 && c.total === 0) return null;
  return (
    <div className="tb-comp">
      <div className="tb-comp-row">
        {c.parts.map(({ template, issue }) =>
          issue ? (
            <span key={template.id} className="tb-tile" style={{ background: view.colors.get(issue.status) }} title={`${issue.key} ${template.title}: ${view.statusName(issue.status)}`}>
              {template.id}
            </span>
          ) : (
            <span key={template.id} className="tb-tile tb-tile-miss" title={t.noTaskYet(template.title)}>
              {template.id}
            </span>
          ),
        )}
        {c.extra.length > 0 ? (
          // Every task outside the template parts shares one cell: a story with dozens of tasks
          // keeps the card's width (one tile per task ran past the card's right edge).
          <span className="tb-tile tb-tile-extra" title={extraTitle(t, c.extra, view.statusName)}>
            +{c.extra.length}
          </span>
        ) : null}
      </div>
      <div className="tb-comp-cap">
        <span>{t.doneOf(c.done, c.total)}</span>
        {c.missing.length > 0 ? <span>{t.missing(c.missing.length)}</span> : null}
      </div>
    </div>
  );
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
  const parent = issue.parent ? view.byKey.get(issue.parent) : undefined;
  const late = isLate(issue, view.today);
  const showParent = has("parent") && parent && !(display.group === "story" && parent.kind === "story");
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
      {showParent || (has("due") && issue.due) || has("assignee") ? (
        <div className="tb-c-meta">
          {showParent && parent ? (
            <span className="tb-parent tb-grow" title={`${t.parentLabel}: ${parent.key} ${parent.summary}`}>
              ↑ {parent.key} {splitPrefix(parent.summary).rest}
            </span>
          ) : (
            <span className="tb-grow" />
          )}
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
