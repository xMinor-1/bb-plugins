// The whole task in bb's side panel: description, child tasks, comments, fields.
// Changes made here go to the tracker at once: the click is the person's decision.
import { experimental_copyToClipboard, Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import type { ChangeInput } from "../shared/changes";
import { ancestors, splitPrefix, type Issue } from "../shared/model";
import { compositionOf } from "../shared/templates";
import type { IssueView, rpcContract } from "../server/rpc-contract";
import { PeoplePicker } from "./Bulk";
import { messages } from "./messages";
import { Avatar, Dot, formatDate, Icons, Priority, StatusPill, statusColors, TitleText, TypeTile } from "./parts";
import { applyNow, boardStore, chatOpenStore, configStore, errorText, failureText, openKeyStore, patchIssue, pendingPillsStore, prefsStore, reloadBoard, useStore } from "./store";
import { templatesRequestStore, useOpenIssue } from "./requests";
import { Popover, Spinner } from "./ui";
import { ParentExtra, ParentPath, useTree, type PathData } from "./ParentPath";
import { childrenOf, compositionParts, personTemplates } from "./view";
import { openInOwnBrowser } from "./links";

export function IssueTab({ params }: { params: unknown }) {
  const key = params && typeof params === "object" && "key" in params && typeof (params as { key: unknown }).key === "string" ? (params as { key: string }).key : null;
  const t = useMessages(messages);
  const lang = useLang();
  const locale = intlLocale(lang);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const config = useStore(configStore);
  const prefs = useStore(prefsStore);
  const { board } = useStore(boardStore);
  const [view, setView] = useState<IssueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<"assignee" | null>(null);
  const [comment, setComment] = useState("");
  const request = useRef(0);
  const openIssueTab = useOpenIssue();

  const load = useCallback(() => {
    if (!key) return;
    const id = ++request.current;
    rpc.call("issue", { key }).then(
      (next) => {
        if (id !== request.current) return;
        setView(next);
        setError(null);
        patchIssue(next.issue);
      },
      (cause) => id === request.current && setError(errorText(t, cause)),
    );
  }, [key, rpc, t]);
  useEffect(() => {
    setView(null);
    load();
    if (key) openKeyStore.set(key);
    return () => {
      if (openKeyStore.get() === key) openKeyStore.set(null);
    };
  }, [key, load]);
  useEffect(() => {
    if (!config) rpc.call("config").then(configStore.set, () => undefined);
  }, [config, rpc]);
  useRealtime("changed", (payload) => {
    const keys = (payload as { keys?: unknown }).keys;
    if (key && Array.isArray(keys) && keys.includes(key)) load();
  });

  // The top parent's whole tree, for the parents' composition and progress. The board in
  // view already holds it when it is that parent's own tree.
  const shown = view && view.issue.key === key ? view.issue : null;
  const pathMap = new Map([...(board?.parents ?? []), ...(view?.parents ?? []), ...(board?.issues ?? [])].map((item) => [item.key, item]));
  const top = shown ? (ancestors(shown, pathMap)[0] ?? (shown.kind === "story" || shown.kind === "epic" ? shown : null)) : null;
  const boardHasTree = Boolean(top && board && board.source.kind === "issue" && !board.truncated && board.issues.some((item) => item.key === top.key));
  const tree = useTree(rpc, top?.key ?? null, Boolean(top) && !boardHasTree);

  if (!key) return <p className="tb-pad tb-hint">—</p>;
  if (error && !view) return <p className="tb-pad tb-error">{error}</p>;
  if (!view || !config) {
    return (
      <div className="tb-pad">
        <Spinner label={t.loading} />
      </div>
    );
  }
  const issue = view.issue;
  const statuses = board?.statuses ?? config.statuses;
  const colors = statusColors(statuses);
  const statusName = (status: string) => statuses.find((item) => item.key === status)?.name ?? status;
  const byKey = new Map([...(board?.parents ?? []), ...(view.parents ?? []), ...(board?.issues ?? [])].map((item) => [item.key, item]));
  const chain = ancestors(issue, byKey);
  const treeIssues = boardHasTree ? board!.issues : tree.issues;
  const treeKids = treeIssues ? childrenOf(treeIssues) : null;
  const kids: Issue[] = view.children ?? treeKids?.get(issue.key) ?? (board?.issues ?? []).filter((item) => item.parent === issue.key);
  const templates = config.templates;
  const parts = compositionOf({ templates: templates.filter((template) => !template.own), bundles: config.bundles, composition: config.composition });
  const missing =
    issue.kind === "story"
      ? parts.filter((id) => {
          const template = templates.find((item) => item.id === id);
          return template && !kids.some((kid) => splitPrefix(kid.summary).prefix.toLowerCase() === id.toLowerCase());
        })
      : [];
  const pathData: PathData = {
    t,
    children: treeKids,
    loading: tree.loading,
    parts: compositionParts(config, personTemplates(config, prefs?.templates ?? [])),
    statuses,
    colors,
    statusName,
  };
  const people = [...(prefs?.people ?? []), ...(board?.people ?? []).filter((person) => !(prefs?.people ?? []).some((known) => known.id === person.id))];
  const webUrl = config.webUrl ? config.webUrl.replace("{key}", encodeURIComponent(issue.key)) : null;

  const change = async (next: ChangeInput, done?: string) => {
    setBusy(true);
    try {
      const { failed } = await applyNow(rpc, [next]);
      if (failed.length > 0) toast.error(t.changeFailed(failureText(t, failed[0]!.code, failed[0]!.why)));
      else if (done) toast.success(done);
      load();
      void reloadBoard(rpc);
    } catch (cause) {
      toast.error(t.changeFailed(errorText(t, cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-root tb-tab">
      <div className="tb-tab-tools">
        <TypeTile kind={issue.kind} t={t} />
        <span className="tb-key">{issue.key}</span>
        <span className="tb-grow" />
        {busy ? <Spinner /> : null}
        {webUrl ? (
          <>
            <button
              className="tb-ib"
              type="button"
              title={t.copyLink}
              aria-label={t.copyLink}
              onClick={() => void experimental_copyToClipboard({ text: webUrl }).then(() => toast.success(t.linkCopied))}
            >
              <Icons.link />
            </button>
            <button className="tb-ib" type="button" title={t.openInTracker} aria-label={t.openInTracker} onClick={() => openInOwnBrowser(webUrl, navigate.openUrl)}>
              <Icons.ext />
            </button>
          </>
        ) : null}
      </div>
      <div className="tb-tab-b">
        <ParentPath issue={issue} chain={chain} data={pathData} onOpen={openIssueTab} />
        <h1 className="tb-d-title">
          <TitleText issue={issue} />
        </h1>
        {issue.kind === "story" || issue.kind === "epic" ? (
          <div className="tb-d-extra">
            <ParentExtra issue={issue} data={pathData} />
          </div>
        ) : null}
        <div className="tb-d-ctl">
          <label className="tb-ctl">
            <Dot color={colors.get(issue.status)} />
            <select value={issue.status} disabled={busy || !config.can.status} onChange={(event) => void change({ kind: "status", key: issue.key, to: event.target.value }, t.statusChanged(issue.key, statusName(event.target.value)))} aria-label={t.status}>
              {statuses.some((status) => status.key === issue.status) ? null : <option value={issue.status}>{issue.statusName ?? issue.status}</option>}
              {statuses.map((status) => (
                <option key={status.key} value={status.key}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <Popover
            open={menu === "assignee"}
            onClose={() => setMenu(null)}
            className="tb-menu"
            trigger={
              <button className="tb-ctl" type="button" disabled={busy || !config.can.assign} onClick={() => setMenu(menu ? null : "assignee")} aria-label={t.assignee}>
                <Avatar id={issue.assignee} name={issue.assigneeName} size={18} t={t} />
                <span>{issue.assignee ? issue.assigneeName ?? issue.assignee : t.noAssignee}</span>
                <Icons.chevD />
              </button>
            }
          >
            <PeoplePicker
              t={t}
              rpc={rpc}
              people={people}
              allowNone
              onPick={(person) => {
                setMenu(null);
                void change({ kind: "assignee", key: issue.key, to: person?.id ?? null }, t.saved);
              }}
            />
          </Popover>
          {config.priorities.length > 0 ? (
            <label className="tb-ctl">
              <Priority value={issue.priority} t={t} />
              <select value={issue.priority ?? ""} disabled={busy || !config.can.priority} onChange={(event) => void change({ kind: "priority", key: issue.key, to: event.target.value }, t.saved)} aria-label={t.priority}>
                {issue.priority && !config.priorities.some((priority) => priority.key === issue.priority) ? <option value={issue.priority}>{issue.priority}</option> : null}
                {issue.priority ? null : <option value="">—</option>}
                {config.priorities.map((priority) => (
                  <option key={priority.key} value={priority.key}>
                    {priority.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className="tb-btn"
            type="button"
            onClick={() => {
              pendingPillsStore.set([...pendingPillsStore.get(), issue.key]);
              chatOpenStore.set(true);
            }}
          >
            <Icons.chat />
            {t.toChat}
          </button>
        </div>
        <div className="tb-d-grid">
          <div>
            <section className="tb-sec">
              <h3>{t.description}</h3>
              {issue.description ? (
                <div className="tb-md">
                  <Markdown content={issue.description} />
                </div>
              ) : (
                <p className="tb-hint">{t.noDescription}</p>
              )}
            </section>
            {kids.length > 0 || issue.kind === "story" || issue.kind === "epic" ? (
              <section className="tb-sec">
                <h3>
                  {t.children} <span className="tb-n">{kids.length}</span>
                  <span className="tb-grow" />
                  {config.can.create ? (
                    <button className="tb-btn" type="button" onClick={() => templatesRequestStore.set({ key: issue.key, at: Date.now() })}>
                      <Icons.plus />
                      {issue.kind === "epic" ? t.storyByTemplate : t.byTemplate}
                    </button>
                  ) : null}
                </h3>
                <div className="tb-kids">
                  {kids.map((kid) => (
                    <button key={kid.key} className="tb-kid" type="button" onClick={() => openIssueTab(kid.key)}>
                      <TypeTile kind={kid.kind} t={t} />
                      <span className="tb-key">{kid.key}</span>
                      <span className="tb-t">
                        <TitleText issue={kid} />
                      </span>
                      <StatusPill name={kid.statusName ?? statusName(kid.status)} color={colors.get(kid.status)} />
                      <Avatar id={kid.assignee} name={kid.assigneeName} size={20} t={t} />
                    </button>
                  ))}
                  {missing.map((id) => {
                    const template = templates.find((item) => item.id === id);
                    return (
                      <div key={id} className="tb-kid tb-kid-ghost">
                        <span className="tb-ty tb-ty-ghost" />
                        <span className="tb-t">
                          <span className="tb-pfx tb-pfx-ghost">{id}</span>
                          {t.noTaskYet(template?.title ?? id)}
                        </span>
                      </div>
                    );
                  })}
                  {kids.length === 0 && missing.length === 0 ? (
                    <div className="tb-kid tb-kid-ghost">
                      <span className="tb-t">{t.noChildren}</span>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
            {view.comments !== null || config.can.addComment ? (
              <section className="tb-sec">
                <h3>
                  {t.comments} <span className="tb-n">{view.comments?.length ?? 0}</span>
                </h3>
                {(view.comments ?? []).map((item) => (
                  <div key={item.id || item.text.slice(0, 40)} className="tb-cm">
                    <Avatar id={item.author ?? "?"} name={item.authorName ?? item.author} size={24} t={t} />
                    <div className="tb-who">
                      {item.authorName ?? item.author ?? "?"}
                      <span>{formatDate(item.created, locale)}</span>
                    </div>
                    <div className="tb-cm-txt tb-md">
                      <Markdown content={item.text} />
                    </div>
                  </div>
                ))}
                {view.comments && view.comments.length === 0 ? <p className="tb-hint">{t.noComments}</p> : null}
                {config.can.addComment ? (
                  <div className="tb-cm-add">
                    <textarea className="tb-inp" rows={2} placeholder={t.commentPlaceholder} value={comment} onChange={(event) => setComment(event.target.value)} aria-label={t.addComment} />
                    <button
                      className="tb-btn"
                      type="button"
                      disabled={busy || comment.trim() === ""}
                      onClick={() => {
                        const text = comment.trim();
                        setComment("");
                        void change({ kind: "comment", key: issue.key, text }, t.saved);
                      }}
                    >
                      {t.send}
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
          <dl className="tb-fields">
            <dt>{t.status}</dt>
            <dd>
              <StatusPill name={issue.statusName ?? statusName(issue.status)} color={colors.get(issue.status)} />
            </dd>
            <dt>{t.type}</dt>
            <dd>{config.types.find((type) => type.key === issue.type)?.name ?? issue.type}</dd>
            <dt>{t.labels}</dt>
            <dd>
              <span className="tb-labels">
                {issue.labels.map((label) => (
                  <span key={label} className="tb-lbl">
                    {label}
                    {config.can.labels ? (
                      <button className="tb-lbl-x" type="button" aria-label={`${t.removeLabel} ${label}`} onClick={() => void change({ kind: "labels", key: issue.key, add: [], remove: [label] }, t.saved)}>
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {config.can.labels ? <LabelAdder t={t} onAdd={(label) => void change({ kind: "labels", key: issue.key, add: [label], remove: [] }, t.saved)} /> : null}
              </span>
            </dd>
            {view.components !== null || issue.components.length > 0 ? (
              <>
                <dt>{t.components}</dt>
                <dd>
                  {(view.components ?? issue.components).map((component) => (
                    <span key={component} className="tb-lbl tb-lbl-comp">
                      {component}
                    </span>
                  ))}
                  {(view.components ?? issue.components).length === 0 ? <span className="tb-hint">{t.none}</span> : null}
                </dd>
              </>
            ) : null}
            <dt>{t.parent}</dt>
            <dd>
              {issue.parent ? (
                <button className="tb-addl tb-addl-solid" type="button" onClick={() => openIssueTab(issue.parent!)}>
                  {issue.parent}
                  {byKey.get(issue.parent) ? ` ${splitPrefix(byKey.get(issue.parent)!.summary).rest}` : ""}
                </button>
              ) : (
                <span className="tb-hint">{t.none}</span>
              )}
            </dd>
            {issue.due ? (
              <>
                <dt>{t.due}</dt>
                <dd>{formatDate(issue.due, locale)}</dd>
              </>
            ) : null}
            {issue.start ? (
              <>
                <dt>{t.start}</dt>
                <dd>{formatDate(issue.start, locale)}</dd>
              </>
            ) : null}
            {issue.author ? (
              <>
                <dt>{t.author}</dt>
                <dd>{issue.authorName ?? issue.author}</dd>
              </>
            ) : null}
            {issue.created ? (
              <>
                <dt>{t.createdAt}</dt>
                <dd>{formatDate(issue.created, locale)}</dd>
              </>
            ) : null}
            {issue.updated ? (
              <>
                <dt>{t.updatedAt}</dt>
                <dd>{formatDate(issue.updated, locale)}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
    </div>
  );
}

function LabelAdder({ t, onAdd }: { t: Messages; onAdd: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button className="tb-addl" type="button" onClick={() => setOpen(true)}>
        {t.plusLabel}
      </button>
    );
  }
  return (
    <input
      className="tb-inp tb-inp-s"
      autoFocus
      value={text}
      placeholder={t.newLabel}
      aria-label={t.newLabel}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
        if (event.key === "Enter" && text.trim()) {
          onAdd(text.trim());
          setText("");
          setOpen(false);
        }
      }}
    />
  );
}

type Messages = (typeof messages)["en"];
