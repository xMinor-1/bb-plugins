// The board page and its title bar controls.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import { boardCards, type Issue, type Person } from "../shared/model";
import type { Display, Source } from "../shared/prefs";
import type { rpcContract } from "../server/rpc-contract";
import { boardColumns, BoardView, ListView } from "./Board";
import { HeaderStar, InterestStep, needsInterest, SourcePicker, type BoardItem } from "./Boards";
import { BulkBar, BulkDialog, type BulkRequest } from "./Bulk";
import { ChatColumn, ChatSplitter } from "./Chat";
import { messages } from "./messages";
import { Icons, statusColors, todayText } from "./parts";
import { templatesRequestStore, useOpenIssue } from "./requests";
import { SettingsView } from "./Settings";
import {
  applyNow,
  boardStore,
  chatOpenStore,
  configStore,
  errorText,
  failureText,
  flash,
  flashStore,
  loadBoard,
  openKeyStore,
  patchIssue,
  pendingPillsStore,
  prefsStore,
  reloadBoard,
  savePrefs,
  selectionStore,
  settingsOpenStore,
  toggleSelected,
  useStore,
  type Rpc,
} from "./store";
import { TemplatesDialog } from "./Templates";
import { applyFilters, NO_FILTERS, Toolbar, type Filters } from "./Toolbar";
import { Spinner } from "./ui";
import { childrenOf, ViewContext, type ViewData } from "./view";
import { mergeTemplates } from "../shared/templates";

let started = false;

/** Loads the configuration, the person's settings and the last board once per page load. */
async function start(rpc: Rpc): Promise<void> {
  if (started) return;
  started = true;
  try {
    const [config, prefs] = await Promise.all([rpc.call("config"), rpc.call("prefs")]);
    configStore.set(config);
    prefsStore.set(prefs);
    if (prefs.source && !config.problem) await loadBoard(rpc, prefs.source);
  } catch (error) {
    started = false;
    boardStore.set((current) => ({ ...current, error }));
  }
}

function minutesSince(at: number | undefined): number {
  return at ? Math.floor((Date.now() - at) / 60_000) : 0;
}

/** The right side of bb's title bar: what to show, the view, chat, refresh, settings. */
export function PageHeader() {
  const t = useMessages(messages);
  const rpc = useRpc<typeof rpcContract>();
  const config = useStore(configStore);
  const prefs = useStore(prefsStore);
  const { board, loading } = useStore(boardStore);
  const chatOpen = useStore(chatOpenStore);
  const settingsOpen = useStore(settingsOpenStore);
  useEffect(() => void start(rpc), [rpc]);
  if (!config || !prefs) return null;
  const view = prefs.display.view;
  const setView = (next: Display["view"]) => void savePrefs(rpc, { display: { ...prefs.display, view: next } });
  const firstRun = needsInterest(config, prefs);
  const current: BoardItem | null = board ? { source: board.source, title: board.title, ...(board.root ? { kind: board.root.kind } : {}) } : null;
  return (
    <div className="tb-root tb-ph">
      {settingsOpen || firstRun ? null : (
        <>
          {current ? <HeaderStar t={t} rpc={rpc} config={config} prefs={prefs} item={current} /> : null}
          <SourcePicker t={t} rpc={rpc} config={config} prefs={prefs} current={current} onPick={(source: Source) => void loadBoard(rpc, source)} />
        </>
      )}
      <span className="tb-grow" />
      {settingsOpen ? (
        <button className="tb-btn" type="button" onClick={() => settingsOpenStore.set(false)}>
          {t.toBoard}
        </button>
      ) : firstRun ? null : (
        <>
          <div className="tb-seg" role="group" aria-label={t.board}>
            <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")} title={t.board} aria-label={t.board}>
              <Icons.board />
              <span className="tb-lt-hide">{t.board}</span>
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} title={t.list} aria-label={t.list}>
              <Icons.list />
              <span className="tb-lt-hide">{t.list}</span>
            </button>
          </div>
          <button className={`tb-btn tb-btn-ic${chatOpen ? " tb-on" : ""}`} type="button" onClick={() => chatOpenStore.set(!chatOpen)} title={t.chatHint} aria-label={t.chat} aria-pressed={chatOpen}>
            <Icons.chat />
            <span className="tb-lt-hide">{t.chat}</span>
          </button>
          <button className="tb-ib tb-ph-opt" type="button" onClick={() => void reloadBoard(rpc)} title={t.refreshedAgo(minutesSince(board?.loadedAt))} aria-label={t.refresh} disabled={loading}>
            {loading ? <Spinner /> : <Icons.refresh />}
          </button>
        </>
      )}
      <button className={`tb-ib${settingsOpen ? " tb-on" : ""}`} type="button" onClick={() => settingsOpenStore.set(!settingsOpen)} title={t.settings} aria-label={t.settings} aria-pressed={settingsOpen}>
        <Icons.gear />
      </button>
    </div>
  );
}

export function BoardPage() {
  const t = useMessages(messages);
  const lang = useLang();
  const rpc = useRpc<typeof rpcContract>();
  const config = useStore(configStore);
  const prefs = useStore(prefsStore);
  const { board, loading, error } = useStore(boardStore);
  const selection = useStore(selectionStore);
  const flashed = useStore(flashStore);
  const openKey = useStore(openKeyStore);
  const chatOpen = useStore(chatOpenStore);
  const settingsOpen = useStore(settingsOpenStore);
  const templatesRequest = useStore(templatesRequestStore);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [bulk, setBulk] = useState<BulkRequest | null>(null);
  const [templatesFor, setTemplatesFor] = useState<string | null>(null);
  const openIssue = useOpenIssue();
  const lastReload = useRef(0);

  useEffect(() => void start(rpc), [rpc]);
  useEffect(() => {
    if (templatesRequest) setTemplatesFor(templatesRequest.key);
  }, [templatesRequest]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionStore.get().size > 0 && !(event.target instanceof HTMLInputElement)) selectionStore.set(new Set());
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  // The agent or another window changed tasks: read the board again, at most once a second.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime("changed", () => {
    if (pending.current) return;
    const wait = Math.max(300, 1000 - (Date.now() - lastReload.current));
    pending.current = setTimeout(() => {
      pending.current = null;
      lastReload.current = Date.now();
      void reloadBoard(rpc);
    }, wait);
  });
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const people: Person[] = useMemo(() => {
    const out = [...(prefs?.people ?? [])];
    for (const person of board?.people ?? []) if (!out.some((known) => known.id === person.id)) out.push(person);
    return out;
  }, [prefs?.people, board?.people]);

  const drop = useCallback(
    async (key: string, status: string) => {
      const issue = boardStore.get().board?.issues.find((item) => item.key === key);
      if (!issue || issue.status === status) return;
      const before = issue.status;
      const statusName = (value: string) => boardStore.get().board?.statuses.find((item) => item.key === value)?.name ?? value;
      patchIssue({ ...issue, status, statusName: statusName(status) });
      try {
        const { failed } = await applyNow(rpc, [{ kind: "status", key, to: status }]);
        if (failed.length > 0) {
          patchIssue(issue);
          toast.error(t.changeFailed(failureText(t, failed[0]!.code, failed[0]!.why)));
          return;
        }
        flash([key]);
        toast.success(t.statusChanged(key, statusName(status)), {
          action: {
            label: t.undo,
            // Only this task goes back; changes to other tasks since then stay.
            onClick: () => void applyNow(rpc, [{ kind: "status", key, to: before }]).then(() => reloadBoard(rpc)),
          },
        });
        void reloadBoard(rpc);
      } catch (cause) {
        patchIssue(issue);
        toast.error(t.changeFailed(errorText(t, cause)));
      }
    },
    [rpc, t],
  );

  if (!config || !prefs) {
    return (
      <div className="tb-root tb-page tb-center">
        {error ? <p className="tb-error">{errorText(t, error)}</p> : <Spinner label={t.loading} />}
      </div>
    );
  }

  const toChat = (keys: string[]) => {
    pendingPillsStore.set([...new Set([...pendingPillsStore.get(), ...keys])]);
    chatOpenStore.set(true);
  };

  let body;
  let data: ViewData | null = null;
  let visible: Issue[] = [];
  if (board) {
    const byKey = new Map(board.issues.map((issue) => [issue.key, issue]));
    const children = childrenOf(board.issues);
    const templates = mergeTemplates(
      config.templates.filter((template) => !template.own),
      prefs.templates,
    );
    const parts = config.composition.map((id) => templates.find((template) => template.id === id)).filter((template): template is (typeof templates)[number] => Boolean(template));
    const names = new Map(people.map((person) => [person.id, person.name]));
    data = {
      t,
      lang,
      locale: intlLocale(lang),
      today: todayText(),
      config,
      board,
      display: prefs.display,
      statuses: board.statuses,
      colors: statusColors(board.statuses),
      byKey,
      chain: new Map([...board.parents, ...board.issues].map((issue) => [issue.key, issue])),
      children,
      templates,
      parts,
      selection,
      flash: flashed,
      openKey,
      open: openIssue,
      pick: toggleSelected,
      statusName: (key) => board.statuses.find((status) => status.key === key)?.name ?? key,
      priorityName: (key) => (key ? config.priorities.find((priority) => priority.key === key)?.name : undefined),
      personName: (id) => (id ? names.get(id) ?? id : t.nobody),
      drop: (key, status) => void drop(key, status),
      addFromTemplates: setTemplatesFor,
    };
    const filtered = applyFilters(board.issues, filters, board.me?.id ?? null, data.personName);
    if (prefs.display.view === "list") {
      body = <ListView visible={filtered} rootKey={board.root?.key ?? null} />;
    } else {
      visible = boardCards(filtered, board.root?.key ?? null);
      const configured = new Set(config.statuses.map((status) => status.key));
      body = <BoardView visible={visible} columns={boardColumns(board.statuses, configured, visible)} />;
    }
  }

  const work = settingsOpen ? (
    <div className="tb-scroll">
      <SettingsView t={t} rpc={rpc} config={config} prefs={prefs} />
    </div>
  ) : needsInterest(config, prefs) ? (
    <div className="tb-scroll">
      <InterestStep t={t} rpc={rpc} config={config} prefs={prefs} />
    </div>
  ) : (
    <>
      {config.problem ? (
        <div className="tb-banner">
          {t.notConfigured(config.problem)}
        </div>
      ) : null}
      {board ? (
        <Toolbar t={t} filters={filters} setFilters={setFilters} people={people} display={prefs.display} setDisplay={(display) => void savePrefs(rpc, { display })} />
      ) : null}
      {error ? (
        <div className="tb-banner tb-banner-error">
          {errorText(t, error)}
          {["unauthorized", "noKey", "addressChanged", "storeError"].some((code) => String((error as Error)?.message ?? "").includes(code)) ? (
            <button className="tb-btn" type="button" onClick={() => settingsOpenStore.set(true)}>
              {t.settings}
            </button>
          ) : null}
        </div>
      ) : null}
      {board?.truncated ? <div className="tb-banner">{t.truncated(board.issues.length)}</div> : null}
      <div className="tb-scroll">
        {board && data ? body : loading ? (
          <div className="tb-center">
            <Spinner label={t.loading} />
          </div>
        ) : (
          <div className="tb-center tb-hint">{t.pickSource}</div>
        )}
      </div>
      {data ? (
        <ViewContext.Provider value={data}>
          <BulkBar rpc={rpc} people={people} onAsk={setBulk} onChat={toChat} />
        </ViewContext.Provider>
      ) : null}
    </>
  );

  const parent = templatesFor && board ? board.issues.find((issue) => issue.key === templatesFor) ?? null : null;
  const chatShown = chatOpen && !settingsOpen;
  const chatBelow = chatShown && prefs.display.chat === "bottom";
  return (
    <div className="tb-root tb-page">
      <div className={`tb-pb${chatBelow ? " tb-pb-vert" : ""}`} style={chatBelow ? { ["--tb-chat-h" as string]: `${prefs.display.chatHeight}%` } : undefined}>
        <div className={`tb-work${selection.size > 0 ? " tb-selecting" : ""}`}>{data ? <ViewContext.Provider value={data}>{work}</ViewContext.Provider> : work}</div>
        {chatShown && chatBelow ? <ChatSplitter t={t} height={prefs.display.chatHeight} onResize={(chatHeight) => void savePrefs(rpc, { display: { ...prefs.display, chatHeight } })} /> : null}
        {chatShown ? <ChatColumn t={t} rpc={rpc} agentsAllowed={config.agentsAllowed} confirm={prefs.confirmAgent ?? config.confirmDefault} place={prefs.display.chat} onPlace={(chat) => void savePrefs(rpc, { display: { ...prefs.display, chat } })} /> : null}
      </div>
      {bulk && data ? (
        <ViewContext.Provider value={data}>
          <BulkDialog rpc={rpc} request={bulk} onClose={() => setBulk(null)} />
        </ViewContext.Provider>
      ) : null}
      {parent && data ? (
        <TemplatesDialog
          t={t}
          rpc={rpc}
          config={config}
          parent={parent}
          children={data.children.get(parent.key) ?? []}
          templates={data.templates}
          people={people}
          me={board?.me ?? null}
          onClose={() => {
            setTemplatesFor(null);
            templatesRequestStore.set(null);
          }}
        />
      ) : null}
    </div>
  );
}
