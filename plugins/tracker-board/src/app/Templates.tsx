import { useMemo, useState } from "react";
import type { ChangeInput, ChangeResult } from "../shared/changes";
import { splitPrefix, type Issue, type Person } from "../shared/model";
import { fits, planRows, type PlanRow, type Template } from "../shared/templates";
import type { ConfigView } from "../server/rpc-contract";
import type { Messages } from "./messages";
import { Icons, TypeTile } from "./parts";
import { errorText, failureText, flash, reloadBoard, type Rpc } from "./store";
import { Modal, Spinner } from "./ui";

interface SetOption {
  id: string;
  name: string;
  sub: string;
  items: { template: string; children?: readonly string[] }[];
}

function setsFor(t: Messages, config: ConfigView, parent: Issue, children: readonly Issue[], templates: readonly Template[]): SetOption[] {
  const kind = parent.kind;
  const byId = new Map(templates.map((template) => [template.id, template]));
  const has = (template: Template) => children.some((child) => splitPrefix(child.summary).prefix.toLowerCase() === splitPrefix(`${template.prefix} x`).prefix.toLowerCase() && template.prefix !== "");
  const out: SetOption[] = [];
  if (kind === "story") {
    const parts = config.composition.map((id) => byId.get(id)).filter((template): template is Template => Boolean(template));
    const missing = parts.filter((template) => !has(template));
    if (parts.length > 0) {
      out.push({ id: "_missing", name: t.bundleMissing, sub: missing.map((template) => template.id).join(", ") || t.alreadyAll, items: missing.map((template) => ({ template: template.id })) });
      out.push({ id: "_all", name: parts.map((template) => template.id).join(", "), sub: t.existingSkipped, items: parts.map((template) => ({ template: template.id })) });
    }
  }
  for (const bundle of config.bundles) {
    if (!fits(bundle, kind)) continue;
    out.push({
      id: bundle.id,
      name: bundle.title,
      sub: bundle.items.map((item) => `${item.template}${item.children.length ? `: ${item.children.join(", ")}` : ""}`).join("; "),
      items: bundle.items,
    });
  }
  const own = templates.filter((template) => template.own && fits(template, kind));
  if (own.length > 0) out.push({ id: "_own", name: t.bundleOwn, sub: own.map((template) => template.id).join(", "), items: own.map((template) => ({ template: template.id })) });
  // Every single template that fits, when there are no bundles for this kind of parent.
  if (out.length === 0) {
    const single = templates.filter((template) => fits(template, kind));
    if (single.length > 0) out.push({ id: "_fit", name: single.map((template) => template.id).join(", "), sub: t.existingSkipped, items: single.map((template) => ({ template: template.id })) });
  }
  return out;
}

interface Row extends PlanRow {
  on: boolean;
}

export function TemplatesDialog({
  t,
  rpc,
  config,
  parent,
  children,
  templates,
  people,
  me,
  onClose,
}: {
  t: Messages;
  rpc: Rpc;
  config: ConfigView;
  parent: Issue;
  children: readonly Issue[];
  templates: Template[];
  people: Person[];
  me: Person | null;
  onClose: () => void;
}) {
  const sets = useMemo(() => setsFor(t, config, parent, children, templates), [config, parent, children, templates]);
  const [setId, setSetId] = useState(sets[0]?.id ?? "");
  const makeRows = (id: string): Row[] => {
    const set = sets.find((item) => item.id === id);
    if (!set) return [];
    return planRows({ parent, children, templates, now: new Date(), defaultType: config.types[0]?.key ?? "" }, set.items).map((row) => ({ ...row, on: row.exists === null }));
  };
  const [rows, setRows] = useState<Row[]>(() => makeRows(setId));
  const [phase, setPhase] = useState<"edit" | "run" | "done">("edit");
  const [results, setResults] = useState<Map<string, ChangeResult>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(templates.map((template) => [template.id, template]));
  const active = rows.filter((row) => row.on && !row.exists);
  // A row under a row that is switched off has nowhere to go.
  const orphan = (row: Row) => row.parentRef !== null && !rows.some((other) => other.ref === row.parentRef && other.on && !other.exists);
  const creatable = active.filter((row) => !orphan(row));
  const update = (ref: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.ref === ref ? { ...row, ...patch } : row)));
  const run = async () => {
    setPhase("run");
    const changes: ChangeInput[] = creatable.map((row) => ({
      kind: "create",
      ref: row.ref,
      parentKey: row.parentKey,
      parentRef: row.parentRef,
      summary: row.title.trim() || byId.get(row.template)?.title || row.template,
      type: row.type,
      priority: row.priority,
      assignee: row.assignee,
      labels: row.labels,
      components: row.components,
      description: row.description,
      template: row.template,
    }));
    try {
      const answer = await rpc.call("apply", { changes: changes as never, approve: changes.map((_, index) => `c${index + 1}`) });
      const byRef = new Map<string, ChangeResult>();
      answer.results.forEach((result) => {
        const index = Number(result.id.slice(1)) - 1;
        const row = creatable[index];
        if (row) byRef.set(row.ref, result);
      });
      setResults(byRef);
      flash(answer.results.filter((result) => result.ok && result.key).map((result) => result.key!));
      setPhase("done");
      void reloadBoard(rpc);
    } catch (cause) {
      setError(errorText(t, cause));
      setPhase("edit");
    }
  };
  const editing = phase === "edit";
  const created = [...results.values()].filter((result) => result.ok && result.key).map((result) => result.key!);
  const assigneeOptions = [{ id: "", name: t.nobody }, ...(me ? [{ id: "@me", name: me.name }] : [{ id: "@me", name: "@me" }]), { id: "@parent", name: `${t.parent}: ${parent.assigneeName ?? t.nobody}` }, ...people];
  return (
    <Modal label={parent.kind === "epic" ? t.tplTitleEpic : t.tplTitle} onClose={phase === "run" ? () => undefined : onClose}>
      <div className="tb-m-head">
        <h3>{parent.kind === "epic" ? t.tplTitleEpic : t.tplTitle}</h3>
        <p>
          {t.tplParent}: <TypeTile kind={parent.kind} t={t} /> <b>{parent.key}</b> {splitPrefix(parent.summary).rest}. {t.tplHint}
        </p>
      </div>
      <div className="tb-m-body">
        {editing && sets.length > 1 ? (
          <div className="tb-sets" role="group" aria-label={t.template}>
            {sets.map((set) => (
              <button
                key={set.id}
                type="button"
                aria-pressed={set.id === setId}
                onClick={() => {
                  setSetId(set.id);
                  setRows(makeRows(set.id));
                }}
              >
                {set.name}
                <small>{set.sub}</small>
              </button>
            ))}
          </div>
        ) : null}
        {error ? <p className="tb-error">{error}</p> : null}
        <div className="tb-ttbl-wrap">
          <table className="tb-ttbl">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>{t.template}</th>
                <th>{t.title}</th>
                <th>{t.type}</th>
                <th>{t.assignee}</th>
                <th>{t.priority}</th>
                <th>{t.labelsAndComponents}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const template = byId.get(row.template);
                if (row.exists) {
                  return (
                    <tr key={row.ref} className="tb-off">
                      <td>
                        <input className="tb-cb" type="checkbox" disabled aria-label={t.exists(row.exists)} />
                      </td>
                      <td>
                        <span className="tb-pfx">{row.template}</span>
                      </td>
                      <td colSpan={5}>
                        <span className="tb-hint">{t.exists(row.exists)}</span>
                      </td>
                    </tr>
                  );
                }
                const result = results.get(row.ref);
                const off = !row.on || orphan(row);
                return (
                  <tr key={row.ref} className={`${off ? "tb-off" : ""}${row.parentRef ? " tb-child" : ""}`}>
                    <td>
                      {editing ? (
                        <input className="tb-cb" type="checkbox" checked={row.on} onChange={(event) => update(row.ref, { on: event.target.checked })} aria-label={template?.title ?? row.template} />
                      ) : !row.on || orphan(row) ? (
                        <span className="tb-res tb-res-skip">—</span>
                      ) : result?.ok ? (
                        <span className="tb-res tb-res-ok">
                          <Icons.check />
                          {result.key}
                        </span>
                      ) : result ? (
                        <span className="tb-res tb-res-bad" title={failureText(t, result.code, result.detail)}>
                          {t.failed}
                        </span>
                      ) : phase === "run" ? (
                        <Spinner label={t.creating} />
                      ) : (
                        <span className="tb-res tb-res-skip">{t.waits}</span>
                      )}
                    </td>
                    <td className="tb-nowrap">
                      <span className="tb-pfx">{row.template}</span>
                      {template?.title}
                      {template?.own ? <span className="tb-badge">{t.mineBadge}</span> : null}
                    </td>
                    <td>
                      <input type="text" value={row.title} disabled={!editing} onChange={(event) => update(row.ref, { title: event.target.value })} aria-label={t.title} />
                    </td>
                    <td>
                      <select value={row.type} disabled={!editing} onChange={(event) => update(row.ref, { type: event.target.value })} aria-label={t.type}>
                        {(config.types.length > 0 ? config.types : [{ key: row.type, name: row.type }]).map((type) => (
                          <option key={type.key} value={type.key}>
                            {type.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={row.assignee} disabled={!editing} onChange={(event) => update(row.ref, { assignee: event.target.value })} aria-label={t.assignee}>
                        {assigneeOptions.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                        {assigneeOptions.some((person) => person.id === row.assignee) ? null : <option value={row.assignee}>{row.assignee}</option>}
                      </select>
                    </td>
                    <td>
                      <select value={row.priority} disabled={!editing} onChange={(event) => update(row.ref, { priority: event.target.value })} aria-label={t.priority}>
                        <option value="">—</option>
                        {config.priorities.map((priority) => (
                          <option key={priority.key} value={priority.key}>
                            {priority.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className="tb-labels tb-nowrap">
                        {row.labels.map((label) => (
                          <span key={label} className="tb-lbl">
                            {label}
                          </span>
                        ))}
                        {row.components.map((component) => (
                          <span key={component} className="tb-lbl tb-lbl-comp">
                            {component}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="tb-m-foot">
        {phase === "edit" ? (
          <>
            <span className="tb-grow">{t.willCreate(creatable.length)}</span>
            <button className="tb-btn" type="button" onClick={onClose}>
              {t.cancel}
            </button>
            <button className="tb-btn tb-pri" type="button" onClick={run} disabled={creatable.length === 0}>
              {t.create(creatable.length)}
            </button>
          </>
        ) : phase === "run" ? (
          <>
            <span className="tb-grow">{t.creatingHint}</span>
            <button className="tb-btn" type="button" disabled>
              {t.creating}
            </button>
          </>
        ) : (
          <>
            <span className="tb-grow">{created.length > 0 ? t.created(created.join(", ")) : t.createdNone}</span>
            <button className="tb-btn tb-pri" type="button" onClick={onClose}>
              {t.done}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
