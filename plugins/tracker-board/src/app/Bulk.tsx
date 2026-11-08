import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import type { ChangeInput, ChangeResult, PlannedChange } from "../shared/changes";
import { splitPrefix, type Issue, type Person } from "../shared/model";
import type { Messages } from "./messages";
import { Avatar, Dot, Icons, TypeTile } from "./parts";
import { errorText, failureText, flash, reloadBoard, selectionStore, type Rpc } from "./store";
import { Modal, Popover, Spinner } from "./ui";
import { useView } from "./view";

export type BulkKind = "status" | "assignee" | "labelAdd" | "labelRemove" | "parent";

export interface BulkRequest {
  kind: BulkKind;
  value: string | null;
  label: string;
}

function changesFor(request: BulkRequest, keys: readonly string[]): ChangeInput[] {
  return keys.map((key): ChangeInput => {
    switch (request.kind) {
      case "status":
        return { kind: "status", key, to: request.value ?? "" };
      case "assignee":
        return { kind: "assignee", key, to: request.value };
      case "labelAdd":
        return { kind: "labels", key, add: [request.value ?? ""], remove: [] };
      case "labelRemove":
        return { kind: "labels", key, add: [], remove: [request.value ?? ""] };
      case "parent":
        return { kind: "parent", key, to: request.value };
    }
  });
}

export function PeoplePicker({ t, rpc, people, onPick, allowNone }: { t: Messages; rpc: Rpc; people: Person[]; onPick: (person: Person | null) => void; allowNone?: boolean }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const request = useRef(0);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setFound([]);
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      rpc.call("people", { text: trimmed }).then(
        (list) => id === request.current && setFound(list),
        () => id === request.current && setFound([]),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text, rpc]);
  const lower = text.trim().toLowerCase();
  const local = people.filter((person) => lower === "" || person.name.toLowerCase().includes(lower));
  const all = [...local, ...found.filter((person) => !local.some((known) => known.id === person.id))].slice(0, 30);
  return (
    <>
      <input className="tb-pin" placeholder={t.findPerson} aria-label={t.findPerson} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      <div className="tb-mh">{t.assignTo}</div>
      {all.map((person) => (
        <button key={person.id} className="tb-mi" type="button" onClick={() => onPick(person)}>
          <Avatar id={person.id} name={person.name} size={18} t={t} />
          {person.name}
        </button>
      ))}
      {allowNone ? (
        <button className="tb-mi" type="button" onClick={() => onPick(null)}>
          <Avatar id={null} name={null} size={18} t={t} />
          {t.unassign}
        </button>
      ) : null}
    </>
  );
}

export function ParentPicker({ t, rpc, issues, onPick }: { t: Messages; rpc: Rpc; issues: Issue[]; onPick: (issue: Issue) => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Issue[]>([]);
  const request = useRef(0);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setFound([]);
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      rpc.call("find", { text: trimmed }).then(
        ({ issues: list }) => id === request.current && setFound(list),
        () => id === request.current && setFound([]),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text, rpc]);
  const lower = text.trim().toLowerCase();
  const local = issues.filter((issue) => (issue.kind === "epic" || issue.kind === "story") && (lower === "" || issue.key.toLowerCase().includes(lower) || issue.summary.toLowerCase().includes(lower)));
  const all = [...local, ...found.filter((issue) => !local.some((known) => known.key === issue.key))].slice(0, 30);
  return (
    <>
      <input className="tb-pin" placeholder={t.findParent} aria-label={t.findParent} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      <div className="tb-mh">{t.epicOrStory}</div>
      {all.map((issue) => (
        <button key={issue.key} className="tb-mi" type="button" onClick={() => onPick(issue)}>
          <TypeTile kind={issue.kind} t={t} />
          <b>{issue.key}</b>
          <span className="tb-ellipsis">{splitPrefix(issue.summary).rest}</span>
        </button>
      ))}
    </>
  );
}

export function BulkBar({ rpc, people, onAsk, onChat }: { rpc: Rpc; people: Person[]; onAsk: (request: BulkRequest) => void; onChat: (keys: string[]) => void }) {
  const view = useView();
  const { t } = view;
  const [menu, setMenu] = useState<BulkKind | "labels" | null>(null);
  const [label, setLabel] = useState("");
  const keys = [...view.selection];
  const close = () => setMenu(null);
  const selectedLabels = useMemo(() => [...new Set(keys.flatMap((key) => view.byKey.get(key)?.labels ?? []))], [keys.join(","), view.byKey]);
  const allLabels = useMemo(() => [...new Set(view.board.issues.flatMap((issue) => issue.labels))].sort().slice(0, 40), [view.board.issues]);
  if (keys.length === 0) return null;
  const ask = (request: BulkRequest) => {
    close();
    onAsk(request);
  };
  const can = view.config.can;
  return (
    <div className="tb-bulk" role="toolbar" aria-label={t.selected(keys.length)}>
      <b>{t.selected(keys.length)}</b>
      <button className="tb-btn tb-pri" type="button" onClick={() => onChat(keys)}>
        <Icons.chat />
        {t.toChat}
      </button>
      <span className="tb-sep" />
      {can.status ? (
        <Popover
          open={menu === "status"}
          onClose={close}
          place="above-start"
          className="tb-menu"
          trigger={
            <button className="tb-btn tb-ghost" type="button" onClick={() => setMenu(menu === "status" ? null : "status")} aria-expanded={menu === "status"}>
              {t.status}
            </button>
          }
        >
          <div className="tb-mh">{t.moveTo}</div>
          {view.statuses.map((status) => (
            <button key={status.key} className="tb-mi" type="button" onClick={() => ask({ kind: "status", value: status.key, label: status.name })}>
              <Dot color={view.colors.get(status.key)} />
              {status.name}
            </button>
          ))}
        </Popover>
      ) : null}
      {can.assign ? (
        <Popover
          open={menu === "assignee"}
          onClose={close}
          place="above-start"
          className="tb-menu"
          trigger={
            <button className="tb-btn tb-ghost" type="button" onClick={() => setMenu(menu === "assignee" ? null : "assignee")} aria-expanded={menu === "assignee"}>
              {t.assignee}
            </button>
          }
        >
          <PeoplePicker t={t} rpc={rpc} people={people} allowNone onPick={(person) => ask({ kind: "assignee", value: person?.id ?? null, label: person?.name ?? t.nobody })} />
        </Popover>
      ) : null}
      {can.labels ? (
        <Popover
          open={menu === "labels"}
          onClose={close}
          place="above-start"
          className="tb-menu"
          trigger={
            <button className="tb-btn tb-ghost" type="button" onClick={() => setMenu(menu === "labels" ? null : "labels")} aria-expanded={menu === "labels"}>
              {t.labels}
            </button>
          }
        >
          <input
            className="tb-pin"
            placeholder={t.newLabel}
            aria-label={t.newLabel}
            value={label}
            autoFocus
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && label.trim()) {
                ask({ kind: "labelAdd", value: label.trim(), label: label.trim() });
                setLabel("");
              }
            }}
          />
          <div className="tb-mh">{t.addLabel}</div>
          {allLabels
            .filter((item) => !label || item.toLowerCase().includes(label.toLowerCase()))
            .slice(0, 12)
            .map((item) => (
              <button key={`+${item}`} className="tb-mi" type="button" onClick={() => ask({ kind: "labelAdd", value: item, label: item })}>
                + {item}
              </button>
            ))}
          {selectedLabels.length > 0 ? <div className="tb-mh">{t.removeLabel}</div> : null}
          {selectedLabels.map((item) => (
            <button key={`-${item}`} className="tb-mi" type="button" onClick={() => ask({ kind: "labelRemove", value: item, label: item })}>
              − {item}
            </button>
          ))}
        </Popover>
      ) : null}
      {can.parent ? (
        <Popover
          open={menu === "parent"}
          onClose={close}
          place="above-start"
          className="tb-menu"
          trigger={
            <button className="tb-btn tb-ghost" type="button" onClick={() => setMenu(menu === "parent" ? null : "parent")} aria-expanded={menu === "parent"}>
              {t.parent}
            </button>
          }
        >
          <ParentPicker t={t} rpc={rpc} issues={view.board.issues} onPick={(issue) => ask({ kind: "parent", value: issue.key, label: issue.key })} />
        </Popover>
      ) : null}
      <button
        className="tb-btn tb-ghost"
        type="button"
        onClick={() => {
          void experimental_copyToClipboard({ text: keys.join(", ") }).then(() => toast.success(t.keysCopied(keys.join(", "))));
        }}
      >
        {t.keys}
      </button>
      <button className="tb-ib" type="button" onClick={() => selectionStore.set(new Set())} title={t.clearSelection} aria-label={t.clearSelection}>
        <Icons.x />
      </button>
    </div>
  );
}

const TITLE: Record<BulkKind, keyof Messages> = {
  status: "bulkTitle_status",
  assignee: "bulkTitle_assignee",
  labelAdd: "bulkTitle_labelAdd",
  labelRemove: "bulkTitle_labelRemove",
  parent: "bulkTitle_parent",
};

export function BulkDialog({ rpc, request, onClose }: { rpc: Rpc; request: BulkRequest; onClose: () => void }) {
  const view = useView();
  const { t } = view;
  const keys = useMemo(() => [...view.selection], []);
  const changes = useMemo(() => changesFor(request, keys), [request, keys]);
  const [planned, setPlanned] = useState<PlannedChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"edit" | "run" | "done">("edit");
  const [results, setResults] = useState<Map<string, ChangeResult>>(new Map());
  useEffect(() => {
    rpc.call("preview", { changes: changes as never }).then(setPlanned, (cause) => setError(errorText(t, cause)));
  }, [rpc, changes]);
  const ok = planned?.filter((item) => item.ok) ?? [];
  const run = async () => {
    setPhase("run");
    try {
      const answer = await rpc.call("apply", { changes: changes as never, approve: ok.map((item) => item.id) });
      setResults(new Map(answer.results.map((result) => [result.id, result])));
      flash(answer.results.filter((result) => result.ok).map((result) => result.key ?? ""));
      setPhase("done");
      void reloadBoard(rpc);
    } catch (cause) {
      setError(errorText(t, cause));
      setPhase("edit");
    }
  };
  const title = t[TITLE[request.kind]] as string;
  const okCount = [...results.values()].filter((result) => result.ok).length;
  return (
    <Modal label={title} narrow onClose={phase === "run" ? () => undefined : onClose}>
      <div className="tb-m-head">
        <h3>
          {title}: {t.tasks(keys.length)}
        </h3>
        <p>{t.bulkCheck}</p>
      </div>
      <div className="tb-m-body">
        {error ? <p className="tb-error">{error}</p> : null}
        {planned === null && !error ? <Spinner label={t.loading} /> : null}
        {planned ? (
          <table className="tb-chg">
            <tbody>
              {planned.map((item) => {
                const issue = item.key ? view.byKey.get(item.key) : undefined;
                const result = results.get(item.id);
                return (
                  <tr key={item.id} className={item.ok ? "" : "tb-dim"}>
                    <td>{issue ? <TypeTile kind={issue.kind} t={t} /> : null}</td>
                    <td>
                      <span className="tb-key">{item.key}</span>
                    </td>
                    <td className="tb-chg-t" title={item.title}>
                      {item.title}
                    </td>
                    <td className="tb-chg-d">
                      {item.ok ? (
                        <>
                          {item.from ? `${item.from} → ` : ""}
                          <b>{item.to}</b>
                        </>
                      ) : (
                        <span className="tb-hint">{t[`skip_${item.skip ?? "same"}`]}</span>
                      )}
                    </td>
                    <td className="tb-nowrap">
                      {phase === "run" && item.ok && !result ? <Spinner /> : null}
                      {result?.ok ? (
                        <span className="tb-res tb-res-ok">
                          <Icons.check />
                        </span>
                      ) : null}
                      {result && !result.ok ? <span className="tb-res tb-res-bad" title={failureText(t, result.code, result.detail)}>{t.failed}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
      <div className="tb-m-foot">
        {phase === "done" ? (
          <>
            <span className="tb-grow">{t.changedOf(okCount, keys.length)}</span>
            <button
              className="tb-btn tb-pri"
              type="button"
              onClick={() => {
                selectionStore.set(new Set());
                onClose();
              }}
            >
              {t.close}
            </button>
          </>
        ) : (
          <>
            <span className="tb-grow" />
            <button className="tb-btn" type="button" onClick={onClose} disabled={phase === "run"}>
              {t.cancel}
            </button>
            <button className="tb-btn tb-pri" type="button" onClick={run} disabled={ok.length === 0 || phase !== "edit"}>
              {t.applyTo(ok.length)}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
