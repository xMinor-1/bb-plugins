import { useState } from "react";
import type { Issue, Kind } from "../shared/model";
import { CARD_FIELDS, DEFAULT_FIELDS, type CardField, type Display } from "../shared/prefs";
import type { Messages } from "./messages";
import { Avatar, Icons, TypeTile } from "./parts";
import { Popover } from "./ui";

export interface Filters {
  text: string;
  assignee: string | null;
  /** A tracker type key, as the tracker reports it. */
  type: string | null;
  mine: boolean;
}

export const NO_FILTERS: Filters = { text: "", assignee: null, type: null, mine: false };

export interface TypeOption {
  key: string;
  name: string;
  kind: Kind;
  /** Tasks of this type on the board. */
  count: number;
}

/**
 * The type filter's choices: every type the build lists, in its order, even with no tasks
 * on this board, then any other type the board's tasks have.
 */
export function typeOptions(types: readonly { key: string; name: string; kind: Kind }[], issues: readonly Issue[]): TypeOption[] {
  const counts = new Map<string, { n: number; kind: Kind; key: string }>();
  for (const issue of issues) {
    const id = issue.type.toLowerCase();
    const known = counts.get(id);
    counts.set(id, { n: (known?.n ?? 0) + 1, kind: known?.kind ?? issue.kind, key: known?.key ?? issue.type });
  }
  const listed = types.map((type) => ({ key: type.key, name: type.name, kind: type.kind, count: counts.get(type.key.toLowerCase())?.n ?? 0 }));
  const seen = new Set(types.map((type) => type.key.toLowerCase()));
  const extra = [...counts]
    .filter(([id]) => id !== "" && !seen.has(id))
    .map(([, found]) => ({ key: found.key, name: found.key, kind: found.kind, count: found.n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return [...listed, ...extra];
}

export function applyFilters(issues: readonly Issue[], filters: Filters, me: string | null, personName: (id: string | null) => string): Issue[] {
  const q = filters.text.trim().toLowerCase();
  return issues.filter((issue) => {
    if (q) {
      const name = issue.assignee ? (issue.assigneeName ?? personName(issue.assignee)).toLowerCase() : "";
      if (!issue.key.toLowerCase().includes(q) && !issue.summary.toLowerCase().includes(q) && !issue.labels.some((label) => label.toLowerCase().includes(q)) && !name.includes(q)) return false;
    }
    if (filters.assignee === "_none" ? issue.assignee !== null : filters.assignee !== null && issue.assignee !== filters.assignee) return false;
    if (filters.type !== null && issue.type.toLowerCase() !== filters.type.toLowerCase()) return false;
    if (filters.mine && (!me || issue.assignee !== me)) return false;
    return true;
  });
}

export function Toolbar({
  t,
  filters,
  setFilters,
  people,
  types,
  display,
  setDisplay,
}: {
  t: Messages;
  filters: Filters;
  setFilters: (next: Filters) => void;
  people: { id: string; name: string }[];
  types: TypeOption[];
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
          <button className={`tb-fchip${filters.type !== null ? " tb-on" : ""}`} type="button" onClick={() => setMenu(menu === "type" ? null : "type")} aria-expanded={menu === "type"}>
            {t.type}
            {filters.type !== null ? `: ${(types.find((type) => type.key.toLowerCase() === filters.type!.toLowerCase())?.name ?? filters.type).toLowerCase()}` : ""}
          </button>
        }
        className="tb-menu"
      >
        <button className="tb-mi" type="button" onClick={() => (setFilters({ ...filters, type: null }), close())}>
          {t.all}
        </button>
        {types.map((type) => (
          <button key={type.key} className="tb-mi" type="button" aria-pressed={filters.type?.toLowerCase() === type.key.toLowerCase()} onClick={() => (setFilters({ ...filters, type: type.key }), close())}>
            <TypeTile kind={type.kind} t={t} />
            <span className="tb-mi-t">{type.name}</span>
            <span className="tb-mi-n">{type.count}</span>
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
      <h4>{t.chat}</h4>
      <Seg label={t.chatPlace} value={display.chat} options={[["right", t.chatRight], ["bottom", t.chatBottom]]} onChange={(chat) => setDisplay({ ...display, chat })} />
      <div className="tb-disp-foot">
        <span className="tb-hint">{t.savedForYou}</span>
        <button className="tb-btn tb-ghost" type="button" onClick={() => setDisplay({ ...display, group: "none", fields: DEFAULT_FIELDS, clamp: 3, width: "normal" })}>
          {t.reset}
        </button>
      </div>
    </div>
  );
}
