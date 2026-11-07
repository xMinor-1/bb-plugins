import { useEffect, useRef, useState } from "react";
import { splitPrefix, type Issue, type Kind } from "../shared/model";
import { CARD_FIELDS, DEFAULT_FIELDS, sourceFromText, type CardField, type Display, type Prefs, type Source } from "../shared/prefs";
import type { ConfigView } from "../server/rpc-contract";
import type { Messages } from "./messages";
import { Avatar, Icons, TypeTile } from "./parts";
import type { Rpc } from "./store";
import { Popover } from "./ui";

export interface Filters {
  text: string;
  assignee: string | null;
  kind: Kind | null;
  mine: boolean;
}

export const NO_FILTERS: Filters = { text: "", assignee: null, kind: null, mine: false };

export function applyFilters(issues: readonly Issue[], filters: Filters, me: string | null, personName: (id: string | null) => string): Issue[] {
  const q = filters.text.trim().toLowerCase();
  return issues.filter((issue) => {
    if (q) {
      const name = issue.assignee ? (issue.assigneeName ?? personName(issue.assignee)).toLowerCase() : "";
      if (!issue.key.toLowerCase().includes(q) && !issue.summary.toLowerCase().includes(q) && !issue.labels.some((label) => label.toLowerCase().includes(q)) && !name.includes(q)) return false;
    }
    if (filters.assignee === "_none" ? issue.assignee !== null : filters.assignee !== null && issue.assignee !== filters.assignee) return false;
    if (filters.kind && issue.kind !== filters.kind) return false;
    if (filters.mine && (!me || issue.assignee !== me)) return false;
    return true;
  });
}

export function Toolbar({
  t,
  filters,
  setFilters,
  people,
  display,
  setDisplay,
}: {
  t: Messages;
  filters: Filters;
  setFilters: (next: Filters) => void;
  people: { id: string; name: string }[];
  display: Display;
  setDisplay: (next: Display) => void;
}) {
  const [menu, setMenu] = useState<"assignee" | "type" | "display" | null>(null);
  const close = () => setMenu(null);
  const personName = (id: string) => people.find((person) => person.id === id)?.name ?? id;
  return (
    <div className="tb-tb">
      <label className="tb-search">
        <Icons.search />
        <input type="search" placeholder={t.search} value={filters.text} onChange={(event) => setFilters({ ...filters, text: event.target.value })} aria-label={t.search} />
      </label>
      <Popover
        open={menu === "assignee"}
        onClose={close}
        trigger={
          <button className={`tb-fchip${filters.assignee ? " tb-on" : ""}`} type="button" onClick={() => setMenu(menu === "assignee" ? null : "assignee")} aria-expanded={menu === "assignee"}>
            {t.assignee}
            {filters.assignee ? `: ${filters.assignee === "_none" ? t.nobody : personName(filters.assignee).split(" ")[0]}` : ""}
          </button>
        }
        className="tb-menu"
      >
        <button className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, assignee: null }), close())}>
          {t.all}
        </button>
        {people.map((person) => (
          <button key={person.id} className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, assignee: person.id }), close())}>
            <Avatar id={person.id} name={person.name} size={18} t={t} />
            {person.name}
          </button>
        ))}
        <button className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, assignee: "_none" }), close())}>
          <Avatar id={null} name={null} size={18} t={t} />
          {t.noAssignee}
        </button>
      </Popover>
      <Popover
        open={menu === "type"}
        onClose={close}
        trigger={
          <button className={`tb-fchip${filters.kind ? " tb-on" : ""}`} type="button" onClick={() => setMenu(menu === "type" ? null : "type")} aria-expanded={menu === "type"}>
            {t.type}
            {filters.kind ? `: ${t[`type_${filters.kind}`].toLowerCase()}` : ""}
          </button>
        }
        className="tb-menu"
      >
        <button className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, kind: null }), close())}>
          {t.all}
        </button>
        {(["story", "task", "bug"] as const).map((kind) => (
          <button key={kind} className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, kind }), close())}>
            <TypeTile kind={kind} t={t} />
            {t[`type_${kind}`]}
          </button>
        ))}
      </Popover>
      <button className={`tb-fchip${filters.mine ? " tb-on" : ""}`} type="button" aria-pressed={filters.mine} onClick={() => setFilters({ ...filters, mine: !filters.mine })}>
        {t.mineFilter}
      </button>
      <span className="tb-grow" />
      <Popover
        open={menu === "display"}
        onClose={close}
        place="below-end"
        className="tb-disp"
        trigger={
          <button className={`tb-btn${menu === "display" ? " tb-on" : ""}`} type="button" onClick={() => setMenu(menu === "display" ? null : "display")} aria-expanded={menu === "display"}>
            <Icons.sliders />
            <span className="tb-lt-hide">{t.cardLook}</span>
          </button>
        }
      >
        <DisplaySettings t={t} display={display} setDisplay={setDisplay} />
      </Popover>
    </div>
  );
}

function Seg<V extends string | number>({ label, value, options, onChange }: { label: string; value: V; options: [V, string][]; onChange: (value: V) => void }) {
  return (
    <div className="tb-seg" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={String(option)} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const SHOWN_FIELDS = CARD_FIELDS.filter((field) => field !== "comments");

export function DisplaySettings({ t, display, setDisplay }: { t: Messages; display: Display; setDisplay: (next: Display) => void }) {
  const list = display.view === "list";
  const toggle = (field: CardField) => setDisplay({ ...display, fields: display.fields.includes(field) ? display.fields.filter((item) => item !== field) : [...display.fields, field] });
  return (
    <div role="dialog" aria-label={t.cardLook}>
      {list ? null : (
        <>
          <h4>{t.rows}</h4>
          <Seg label={t.rows} value={display.group} options={[["none", t.noRows], ["story", t.byStory], ["assignee", t.byPerson]]} onChange={(group) => setDisplay({ ...display, group })} />
        </>
      )}
      <h4>{list ? t.listColumns : t.onCard}</h4>
      <div className="tb-tog">
        {SHOWN_FIELDS.filter((field) => !list || !["description", "composition", "components"].includes(field)).map((field) => (
          <button key={field} type="button" aria-pressed={display.fields.includes(field)} onClick={() => toggle(field)}>
            {t[`field_${field}`]}
          </button>
        ))}
      </div>
      {list ? null : (
        <>
          <h4>{t.titleLines}</h4>
          <Seg label={t.titleLines} value={display.clamp} options={[[2, t.lines2], [3, t.lines3], [99, t.whole]]} onChange={(clamp) => setDisplay({ ...display, clamp })} />
          <h4>{t.columnWidth}</h4>
          <Seg label={t.columnWidth} value={display.width} options={[["narrow", t.narrow], ["normal", t.normal], ["wide", t.wide]]} onChange={(width) => setDisplay({ ...display, width })} />
        </>
      )}
      <div className="tb-disp-foot">
        <span className="tb-hint">{t.savedForYou}</span>
        <button className="tb-btn tb-ghost" type="button" onClick={() => setDisplay({ view: display.view, group: "none", fields: DEFAULT_FIELDS, clamp: 3, width: "normal" })}>
          {t.reset}
        </button>
      </div>
    </div>
  );
}

/** The board's source: recent boards, search by key or title, a queue, a query. */
export function SourcePicker({ t, rpc, config, prefs, title, root, onPick }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs; title: string | null; root: Issue | null; onPick: (source: Source) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Issue[]>([]);
  const input = useRef<HTMLInputElement | null>(null);
  const request = useRef(0);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setFound([]);
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      rpc.call("find", { text: trimmed }).then(
        ({ issues }) => {
          if (id === request.current) setFound(issues.slice(0, 8));
        },
        () => {
          if (id === request.current) setFound([]);
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text, rpc]);
  const pick = (source: Source) => {
    setOpen(false);
    setText("");
    onPick(source);
  };
  const trimmed = text.trim();
  // A key, a queue or a link to an issue; a link without a key never goes to the tracker as a query.
  const parsed = sourceFromText(trimmed, config.allowQuery);
  const queue = parsed?.kind === "queue" ? parsed.queue : null;
  const key = parsed?.kind === "issue" ? parsed.key : null;
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      className="tb-src-pop"
      trigger={
        <button className="tb-src" type="button" onClick={() => setOpen(!open)} title={t.source} aria-expanded={open}>
          {root ? <TypeTile kind={root.kind} t={t} /> : null}
          {root ? <span className="tb-k">{root.key}</span> : null}
          <span className="tb-t">{root ? splitPrefix(root.summary).rest : title ?? t.source}</span>
          <Icons.chevD />
        </button>
      }
    >
      <input
        ref={input}
        className="tb-pin"
        placeholder={t.sourcePlaceholder}
        aria-label={t.sourcePlaceholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (key) pick({ kind: "issue", key });
          else if (found[0]) pick({ kind: "issue", key: found[0].key });
          else if (parsed) pick(parsed);
        }}
      />
      {found.map((issue) => (
        <button key={issue.key} className="tb-mi" type="button" onClick={() => pick({ kind: "issue", key: issue.key })}>
          <TypeTile kind={issue.kind} t={t} />
          <b>{issue.key}</b>
          <span className="tb-ellipsis">{splitPrefix(issue.summary).rest}</span>
        </button>
      ))}
      {queue ? (
        <button className="tb-mi" type="button" onClick={() => pick({ kind: "queue", queue })}>
          <span className="tb-ty tb-ty-q">Q</span>
          {t.wholeQueue(queue)}
        </button>
      ) : null}
      {parsed?.kind === "query" ? (
        <button className="tb-mi" type="button" onClick={() => pick({ kind: "query", query: trimmed })}>
          <Icons.search />
          {t.queryItem}
        </button>
      ) : null}
      {trimmed.length >= 2 && found.length === 0 && !parsed ? <div className="tb-mh">{t.nothingFound}</div> : null}
      {trimmed === "" ? (
        <>
          {config.can.mine ? (
            <button className="tb-mi" type="button" onClick={() => pick({ kind: "mine" })}>
              <Avatar id="me" name="Me" size={16} t={t} />
              {t.mine}
            </button>
          ) : null}
          {prefs.recent.length > 0 ? <div className="tb-mh">{t.recent}</div> : null}
          {prefs.recent.map((item) => (
            <button key={JSON.stringify(item.source)} className="tb-mi" type="button" onClick={() => pick(item.source)}>
              {item.source.kind === "queue" ? <span className="tb-ty tb-ty-q">Q</span> : item.source.kind === "query" ? <Icons.search /> : null}
              <span className="tb-ellipsis">{item.source.kind === "queue" ? t.wholeQueue(item.title) : item.source.kind === "mine" ? t.mine : item.title}</span>
            </button>
          ))}
        </>
      ) : null}
      <div className="tb-mh">{t.sourceHint}</div>
    </Popover>
  );
}
