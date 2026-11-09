// The "First run" page: the build's setup steps on one page, each done or not,
// with a button to the plugin's own page or the secret field right here. The
// page asks again whenever the person comes back, since steps are done on
// other plugins' pages. Also the reminder on the status page and the badge in
// the sidebar, while steps are left.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import type { BranchSetup, InstallProgress, Setup, SetupMark, SetupStep } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { render, stepErrorText } from "../shared/texts.js";
import { defineMessages, LanguageSwitch, pluralRu, useLang, useMessages } from "@/lib/i18n";
import { AccountBody, StepError } from "./account-step";
import { errorText, Frame, SecretInput, STATUS_CHANNEL, useSavedIn } from "./parts";

/** First run is the Fleet Kit panel's `setup` view: /plugins/fleet-kit/status/setup. */
export const SETUP_SUBPATH = "setup";

/**
 * Whether this browser last saw setup steps left. The panel's root opens First
 * run while it did; unknown (a fresh bb, before the build is read) counts as
 * steps left, so a new person lands on First run.
 */
const SETUP_SEEN_KEY = "fleet-kit.setup-left";

export function startsOnSetup(): boolean {
  try {
    return window.localStorage.getItem(SETUP_SEEN_KEY) !== "done";
  } catch {
    return true;
  }
}

function rememberSteps(setup: Setup): void {
  // Read but not synced yet: keep what was seen before.
  if (!setup.configured && setup.manifestSet) return;
  const left = setup.configured && !setup.complete;
  try {
    window.localStorage.setItem(SETUP_SEEN_KEY, left ? "left" : "done");
  } catch {
    // Private mode: the panel opens First run.
  }
}

const PAGE_POLL_MS = 15_000;
const BADGE_POLL_MS = 60_000;

const stepsRu = (n: number) => pluralRu(n, ["шаг", "шага", "шагов"]);

const messages = defineMessages(
  {
    title: "First run",
    intro: "Set bb up for work. Passwords and tokens go only into each plugin's own form.",
    progress: (done: number, total: number) => `Done ${done} of ${total}`,
    checkAgain: "Check again",
    loading: "Loading…",
    notSynced: "Fleet Kit has not read the build yet. The steps appear after the first sync.",
    noSteps: "This build has no setup steps.",
    allSet: "All set",
    ready: "bb is ready for work.",
    start: "Start working",
    optional: "optional",
    state: (state: SetupStep["state"] | "skipped") =>
      ({ done: "Done", todo: "To do", problem: "Didn't work", installing: "Installing now", queued: "In the queue", later: "Coming later", checking: "Checking…", skipped: "Skipped" })[state],
    manual: "This plugin cannot report its state: mark the step yourself once it is done.",
    noAnswer: "The plugin did not answer. Open its page or check again.",
    installFailed: "The plugin did not install. Details are on the Fleet Kit page.",
    installing: "Fleet Kit is installing the plugin; the step appears here when it is ready.",
    queued: "Fleet Kit installs plugins one at a time; this one waits for its turn.",
    later: "The plugin is not in the build yet.",
    checking: "The plugin is answering slowly; its state appears here as soon as it answers.",
    open: "Open",
    markDone: "Mark as done",
    notDone: "Not done yet",
    skip: "Skip",
    unskip: "Do it after all",
    replace: "Replace",
    left: (n: number) => `First run: ${n} ${n === 1 ? "step" : "steps"} left`,
    continue: "Continue",
    badge: (n: number) => `${n} setup ${n === 1 ? "step" : "steps"} left`,
    branchTitle: "Your set of plugins",
    branchPick: "Pick the branch closest to your work. It turns on the plugins it recommends; you can switch any of them below and change the branch later.",
    branchWaiting: "Plugins that differ between branches are installed once you pick one; the rest are already here.",
    branchNotPicked: "Not picked yet. Everything stays as it was; picking a branch is up to you.",
    branchDropped: "Your branch is no longer in the build. Your plugins stay as they were; pick another branch when you like.",
    branchChange: "Changing the branch puts the switches of branch plugins back to its recommendations; your switches of the rest stay.",
    waitsForBranch: "after you pick a branch",
    confirmTitle: (branch: string) => `Pick "${branch}"?`,
    confirmText: "This turns off:",
    confirmKeep: "Their settings, data and keys stay; you can turn any of them on again here.",
    confirmYes: "Turn off and pick",
    cancel: "Cancel",
    included: "Included",
    recommended: "recommended",
    notRecommended: "not in this branch by default",
    yours: "your choice",
    plannedPlugin: "coming later",
    plannedLine: (names: string) => `Coming in a later version: ${names}.`,
    install: "Install",
    installSwitch: "Switch and install",
    installBusy: "Saving…",
    installStarted: "Done: Fleet Kit is installing the plugins. Progress is shown above; you can carry on with the steps below meanwhile.",
    switchSaved: "Saved. Fleet Kit is applying the change.",
    branchPickFirst: "Pick a branch above, check the plugins, then press Install.",
    installsTitle: "Installing plugins",
    installsDone: "Plugins installed",
    installsCount: (done: number, total: number) => `${done} of ${total}`,
    installsNow: "Installing now",
    installsNext: "Next",
    installsReady: "Installed",
    installsFailed: "Did not install; details are on the Fleet Kit page",
    installsLeft: (n: number, minutes: number | null) =>
      `${n} ${n === 1 ? "plugin" : "plugins"} left${minutes === null ? "" : `, about ${minutes} min`}`,
    installsOneByOne: "One at a time, about a minute each. bb can be used meanwhile.",
    offNote: "A plugin you turn off is not installed, or is turned off if it already is. Its settings, data and keys stay; turn it on to get it back.",
  },
  {
    title: "Первый запуск",
    intro: "Настройте bb для работы. Пароли и токены вводятся только в формах самих плагинов.",
    progress: (done, total) => `Готово ${done} из ${total}`,
    checkAgain: "Проверить снова",
    loading: "Загрузка…",
    notSynced: "Пульт ещё не прочитал сборку. Шаги появятся после первой сверки.",
    noSteps: "В этой сборке нет шагов настройки.",
    allSet: "Всё готово",
    ready: "bb готов к работе.",
    start: "Начать работу",
    optional: "необязательно",
    state: (state) =>
      ({ done: "Готово", todo: "Нужно сделать", problem: "Не получилось", installing: "Ставится сейчас", queued: "В очереди", later: "Появится позже", checking: "Проверяю…", skipped: "Пропущено" })[state],
    manual: "Этот плагин не сообщает о готовности: когда сделаете шаг, отметьте его сами.",
    noAnswer: "Плагин не ответил. Откройте его страницу или проверьте снова.",
    installFailed: "Плагин не установился. Подробности на странице пульта.",
    installing: "Пульт ставит плагин, шаг станет доступен, когда он будет готов.",
    queued: "Пульт ставит плагины по одному, этот ждёт своей очереди.",
    later: "Плагина ещё нет в сборке.",
    checking: "Плагин отвечает медленно, его состояние появится здесь, как только он ответит.",
    open: "Открыть",
    markDone: "Отметить готовым",
    notDone: "Ещё не готово",
    skip: "Пропустить",
    unskip: "Всё-таки сделать",
    replace: "Заменить",
    left: (n) => `Первый запуск: осталось ${n} ${stepsRu(n)}`,
    continue: "Продолжить",
    badge: (n) => `Осталось шагов настройки: ${n}`,
    branchTitle: "Ваш набор плагинов",
    branchPick: "Выберите ветку, ближе всего к вашей работе. Она включит рекомендуемые плагины; любой из них можно переключить ниже, а ветку сменить позже.",
    branchWaiting: "Плагины, которые отличаются по веткам, поставятся после выбора; остальные уже на месте.",
    branchNotPicked: "Ветка не выбрана. Всё остаётся как было, выбирать необязательно.",
    branchDropped: "Вашей ветки больше нет в сборке. Плагины остаются как были; другую ветку можно выбрать когда удобно.",
    branchChange: "При смене ветки переключатели плагинов ветки вернутся к её рекомендациям, остальные ваши переключатели останутся.",
    waitsForBranch: "после выбора ветки",
    confirmTitle: (branch) => `Выбрать «${branch}»?`,
    confirmText: "Выключатся:",
    confirmKeep: "Их настройки, данные и ключи останутся; включить любой можно здесь же.",
    confirmYes: "Выключить и выбрать",
    cancel: "Отмена",
    included: "Что входит",
    recommended: "рекомендуется",
    notRecommended: "в этой ветке по умолчанию выключен",
    yours: "ваш выбор",
    plannedPlugin: "появится позже",
    plannedLine: (names) => `Появится в следующей версии: ${names}.`,
    install: "Установить",
    installSwitch: "Сменить и установить",
    installBusy: "Сохраняю…",
    installStarted: "Готово, пульт ставит плагины. Ход установки — выше; пока он идёт, можно делать шаги ниже.",
    switchSaved: "Сохранено, пульт применяет изменение.",
    branchPickFirst: "Выберите ветку выше, проверьте плагины и нажмите «Установить».",
    installsTitle: "Установка плагинов",
    installsDone: "Плагины установлены",
    installsCount: (done, total) => `${done} из ${total}`,
    installsNow: "Ставится сейчас",
    installsNext: "Дальше",
    installsReady: "Готово",
    installsFailed: "Не установился, подробности на странице пульта",
    installsLeft: (n, minutes) => `Осталось ${n} ${pluralRu(n, ["плагин", "плагина", "плагинов"])}${minutes === null ? "" : `, около ${minutes} мин`}`,
    installsOneByOne: "По одному, примерно минута на плагин. Пользоваться bb можно уже сейчас.",
    offNote: "Выключенный плагин не ставится, а уже поставленный выключается. Его настройки, данные и ключи остаются: включите его снова, и он вернётся как был.",
  },
);
type Texts = (typeof messages)["en"];

/**
 * Open another plugin's page inside bb. The SDK navigates only to this
 * plugin's own panels, so this moves bb's router the way its own links do:
 * a history entry in react-router's shape, then the popstate it listens to.
 */
export function openBbPage(path: string): void {
  if (window.location.pathname === path) return;
  const previous = (window.history.state ?? {}) as { idx?: unknown };
  const idx = typeof previous.idx === "number" ? previous.idx + 1 : 0;
  window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

/** The setup state, asked again on realtime changes, on return to the page and every `pollMs`. */
export function useSetup(pollMs: number) {
  const rpc = useRpc<typeof rpcContract>();
  const lang = useLang();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** `shown`: the person pressed Check again, so the button spins until the answer. */
  const refetch = useCallback((shown = false) => {
    if (shown) setChecking(true);
    rpc.call("setup_status", { lang }).then(
      (value) => {
        rememberSteps(value);
        setSetup(value);
        setError(null);
        setChecking(false);
      },
      (cause) => {
        setError(errorText(cause));
        setChecking(false);
      },
    );
  }, [rpc, lang]);
  const quietly = useCallback(() => refetch(), [refetch]);
  useEffect(() => quietly(), [quietly]);
  useRealtime(STATUS_CHANNEL, quietly);
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") refetch();
    };
    const timer = window.setInterval(again, pollMs);
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [refetch, pollMs]);
  return { rpc, setup, error, setError, checking, refetch };
}

/** A skipped optional step reads as skipped until it is done. */
function shownState(step: SetupStep): SetupStep["state"] | "skipped" {
  return step.optional && step.mark === "skipped" && step.state !== "done" ? "skipped" : step.state;
}

const STATE_ICON: Record<SetupStep["state"] | "skipped", { name: string; className: string }> = {
  done: { name: "CircleCheck", className: "text-emerald-600 dark:text-emerald-400" },
  todo: { name: "Circle", className: "text-muted-foreground" },
  problem: { name: "AlertTriangle", className: "text-amber-600 dark:text-amber-400" },
  installing: { name: "Loading", className: "animate-spin text-muted-foreground" },
  checking: { name: "Loading", className: "animate-spin text-muted-foreground" },
  queued: { name: "Clock", className: "text-muted-foreground" },
  later: { name: "Clock", className: "text-muted-foreground" },
  skipped: { name: "Minus", className: "text-muted-foreground" },
};

function explanation(t: Texts, step: SetupStep): string | null {
  if (shownState(step) === "skipped" || step.kind === "account") return null;
  if (step.summary !== null && step.state !== "installing" && step.state !== "queued" && step.state !== "later") return step.summary;
  if (step.state === "installing") return t.installing;
  if (step.state === "queued") return t.queued;
  if (step.state === "later") return t.later;
  if (step.state === "checking") return t.checking;
  if (step.reason === "install-failed") return t.installFailed;
  if (step.reason === "no-answer") return t.noAnswer;
  if (step.reason === "manual" && step.state !== "done") return t.manual;
  return null;
}

function StepCard({ step, secretStore, error, onMark, onSecret, onAccount, onForget }: {
  step: SetupStep;
  secretStore: string;
  /** Why the last action on this step failed, as the server said it; shown inside the card. */
  error: string | null;
  onMark: (mark: SetupMark | null) => void;
  onSecret: (value: string) => Promise<void>;
  onAccount: (login: string, password: string) => Promise<void>;
  onForget: () => void;
}) {
  const t = useMessages(messages);
  const savedIn = useSavedIn();
  const [replacing, setReplacing] = useState(false);
  const state = shownState(step);
  const icon = STATE_ICON[state];
  const why = explanation(t, step);
  const actionable = state !== "later" && state !== "installing" && state !== "queued" && state !== "checking";
  const openable = step.kind === "plugin" && step.path !== null && actionable && state !== "skipped";
  const primary = state === "todo" || state === "problem";
  useEffect(() => setReplacing(false), [step.state]);
  return (
    <li className="rounded-lg border border-border bg-card px-4 py-3 text-sm" data-step={step.id} data-state={state}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{step.title}</span>
          {step.optional ? <span className="ml-2 text-xs text-muted-foreground">({t.optional})</span> : null}
          {step.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{step.hint}</p> : null}
        </div>
        <span className={cn("shrink-0 text-xs", state === "problem" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{t.state(state)}</span>
      </div>
      {why ? <p className={cn("mt-1.5 break-words pl-6 text-xs", state === "problem" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{why}</p> : null}

      {step.kind === "secret" ? (
        step.state === "done" && !replacing ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 break-words">{savedIn(secretStore)}</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setReplacing(true)}>
              {t.replace}
            </Button>
          </div>
        ) : (
          <SecretInput className="mt-2 pl-6" label={step.title} onSave={onSecret} onCancel={step.state === "done" ? () => setReplacing(false) : undefined} />
        )
      ) : null}
      {step.kind === "secret" ? <StepError error={error} /> : null}

      {step.kind === "account" && step.account ? (
        <AccountBody account={step.account} title={step.title} secretStore={secretStore} error={error} onSave={onAccount} onForget={onForget} onOpen={openBbPage} />
      ) : null}

      {step.kind === "plugin" && actionable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
          {openable ? (
            <Button size="sm" variant={primary ? "default" : "outline"} onClick={() => openBbPage(step.path!)}>
              {t.open}
              <Icon name="ArrowRight" className="size-4" />
            </Button>
          ) : null}
          {step.manual && state === "todo" ? (
            <Button size="sm" variant="outline" onClick={() => onMark("done")}>
              {t.markDone}
            </Button>
          ) : null}
          {step.manual && step.mark === "done" ? (
            <Button size="sm" variant="ghost" onClick={() => onMark(null)}>
              {t.notDone}
            </Button>
          ) : null}
          {step.optional && step.state !== "done" ? (
            <Button size="sm" variant="ghost" onClick={() => onMark(state === "skipped" ? null : "skipped")}>
              {state === "skipped" ? t.unskip : t.skip}
            </Button>
          ) : null}
        </div>
      ) : null}
      {step.kind === "plugin" ? <StepError error={error} /> : null}
    </li>
  );
}

/** Minutes left: the average install so far, or a minute each before the first one ends. */
function minutesLeft(progress: InstallProgress): number | null {
  const left = progress.queue.length + (progress.current ? 1 : 0);
  if (left === 0) return null;
  const each = progress.averageSeconds ?? 60;
  return Math.max(1, Math.round((left * each) / 60));
}

/** The plugins a sync installs, one at a time: which one now, which next, which are done. */
export function InstallCard({ progress }: { progress: InstallProgress }) {
  const t = useMessages(messages);
  const total = progress.done.length + progress.queue.length + (progress.current ? 1 : 0);
  const finished = progress.finishedAt !== null;
  const left = progress.queue.length + (progress.current ? 1 : 0);
  const percent = total === 0 ? 100 : Math.round((progress.done.length / total) * 100);
  return (
    <section role="status" aria-live="polite" className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm" data-installs={finished ? "finished" : "running"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon
          name={finished ? "CircleCheck" : "Loading"}
          className={cn("size-4 shrink-0", finished ? "text-emerald-600 dark:text-emerald-400" : "animate-spin text-muted-foreground")}
        />
        <h2 className="min-w-0 flex-1 font-medium">{finished ? t.installsDone : t.installsTitle}</h2>
        <span className="text-xs text-muted-foreground">{t.installsCount(progress.done.length, total)}</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t.installsTitle}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={progress.done.length}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      {!finished ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.installsLeft(left, minutesLeft(progress))}. {t.installsOneByOne}
        </p>
      ) : null}
      <ul className="mt-2 flex flex-col gap-1">
        {progress.done.map((item) => (
          <li key={item.id} data-install={item.id} data-install-state={item.ok ? "done" : "failed"} className="flex items-start gap-2">
            <Icon
              name={item.ok ? "Check" : "AlertTriangle"}
              className={cn("mt-0.5 size-4 shrink-0", item.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}
            />
            <span className="min-w-0 flex-1">{item.title}</span>
            <span className={cn("text-xs", item.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>{item.ok ? t.installsReady : t.installsFailed}</span>
          </li>
        ))}
        {progress.current ? (
          <li data-install={progress.current.id} data-install-state="installing" className="flex items-start gap-2 font-medium">
            <Icon name="Loading" className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 flex-1">
              {progress.current.title}
              {progress.current.note ? <span className="block text-xs font-normal text-muted-foreground">{progress.current.note}</span> : null}
            </span>
            <span className="text-xs font-normal text-muted-foreground">{t.installsNow}</span>
          </li>
        ) : null}
        {progress.queue.map((item, index) => (
          <li key={item.id} data-install={item.id} data-install-state="queued" className="flex items-start gap-2 text-muted-foreground">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-xs tabular-nums">{index + 1}</span>
            <span className="min-w-0 flex-1">
              {item.title}
              {item.note ? <span className="block text-xs">{item.note}</span> : null}
            </span>
            {index === 0 ? <span className="text-xs">{t.installsNext}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The branch and the optional plugins. Picking a branch only previews it: the
 * switches show what it turns on, the person may change them, and nothing
 * installs until Install. Once a branch is installed, a switch applies at once.
 */
function BranchCard({ branches, onChoose, onToggle }: {
  branches: BranchSetup;
  /** Resolves to the plugins the choice would turn off when it needs a confirmation, else to an empty list. */
  onChoose: (branch: string, confirmed: boolean, plugins: Record<string, boolean>) => Promise<string[]>;
  onToggle: (id: string, on: boolean) => void;
}) {
  const t = useMessages(messages);
  const [selected, setSelected] = useState<string | null>(branches.chosen);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ title: string; off: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<"started" | "switched" | null>(null);
  const picked = branches.chosen !== null;
  // Another tab or the CLI picked a branch: follow it.
  useEffect(() => {
    setSelected(branches.chosen);
    setOverrides({});
  }, [branches.chosen]);
  const previewing = selected !== null && selected !== branches.chosen;
  const preview = previewing ? branches.list.find((branch) => branch.id === selected) ?? null : null;
  const select = (id: string) => {
    setSelected(id);
    setOverrides({});
    setConfirm(null);
    setSaved(null);
  };
  const install = (confirmed: boolean) => {
    if (selected === null) return;
    const first = !picked;
    setBusy(true);
    void onChoose(selected, confirmed, overrides)
      .then(
        (off) => {
          const title = branches.list.find((branch) => branch.id === selected)?.title ?? selected;
          setConfirm(off.length > 0 ? { title, off } : null);
          if (off.length === 0) setSaved(first ? "started" : "switched");
        },
        () => undefined,
      )
      .finally(() => setBusy(false));
  };
  const shown = branches.plugins.filter((plugin) => !plugin.planned);
  const planned = branches.plugins.filter((plugin) => plugin.planned);
  const status = picked || previewing ? null : branches.dropped ? t.branchDropped : branches.waiting ? t.branchWaiting : t.branchNotPicked;
  return (
    <section className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm" data-branches={branches.chosen ?? ""} data-selected={selected ?? ""}>
      <div className="flex items-start gap-2">
        <Icon name={picked ? "CircleCheck" : "Circle"} className={cn("mt-0.5 size-4 shrink-0", picked ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{t.branchTitle}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.branchPick}</p>
          {status ? <p className="mt-0.5 text-xs text-muted-foreground" data-branch-status>{status}</p> : null}
        </div>
      </div>
      <div role="radiogroup" aria-label={t.branchTitle} className="mt-3 grid gap-2 pl-6 sm:grid-cols-2">
        {branches.list.map((branch) => {
          const active = branch.id === selected;
          return (
            <button
              key={branch.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-branch={branch.id}
              onClick={() => (active ? undefined : select(branch.id))}
              className={cn(
                "rounded-md border px-3 py-2 text-left transition-colors",
                active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon name={active ? "CircleCheck" : "Circle"} className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
                {branch.title}
              </span>
              {branch.hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{branch.hint}</span> : null}
            </button>
          );
        })}
      </div>
      {picked && !previewing ? <p className="mt-2 pl-6 text-xs text-muted-foreground">{t.branchChange}</p> : null}
      <h3 className="mt-3 pl-6 text-xs font-medium text-muted-foreground">{t.included}</h3>
      <ul className="mt-1 flex flex-col gap-1 pl-6">
        {shown.map((plugin) => {
          const recommended = preview ? (preview.defaults?.[plugin.id] ?? true) : plugin.recommended;
          const on = preview ? (overrides[plugin.id] ?? recommended) : plugin.on;
          const own = preview ? overrides[plugin.id] !== undefined : plugin.own;
          const note = own ? t.yours : !preview && plugin.waiting ? t.waitsForBranch : !preview && !picked ? "" : recommended ? t.recommended : t.notRecommended;
          return (
            <li key={plugin.id} data-plugin={plugin.id} data-on={on} className="flex items-start gap-2 py-1">
              <input
                id={`fleet-kit-plugin-${plugin.id}`}
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={on}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.checked;
                  if (preview) setOverrides((current) => ({ ...current, [plugin.id]: value }));
                  else onToggle(plugin.id, value);
                }}
              />
              <label htmlFor={`fleet-kit-plugin-${plugin.id}`} className="min-w-0 flex-1">
                <span>{plugin.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">{note}</span>
                {plugin.hint ? <span className="block text-xs text-muted-foreground">{plugin.hint}</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
      {planned.length > 0 ? (
        <p className="mt-1 pl-6 text-xs text-muted-foreground" data-planned={planned.map((plugin) => plugin.id).join(" ")}>
          {t.plannedLine(planned.map((plugin) => plugin.title).join(", "))}
        </p>
      ) : null}
      <p className="mt-2 pl-6 text-xs text-muted-foreground">{t.offNote}</p>
      {confirm ? (
        <div role="alertdialog" aria-label={t.confirmTitle(confirm.title)} data-confirm={selected ?? ""} className="mt-3 ml-6 rounded-md border border-amber-500/50 px-3 py-2 text-xs">
          <p className="font-medium">{t.confirmTitle(confirm.title)}</p>
          <p className="mt-1">
            {t.confirmText} {confirm.off.join(", ")}
          </p>
          <p className="mt-1 text-muted-foreground">{t.confirmKeep}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => install(true)}>
              {t.confirmYes}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              {t.cancel}
            </Button>
          </div>
        </div>
      ) : previewing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
          <Button size="sm" disabled={busy} onClick={() => install(false)} data-install-branch={selected ?? ""}>
            <Icon name={busy ? "Loading" : "PackageReceive"} className={cn("size-4", busy && "animate-spin")} />
            {busy ? t.installBusy : picked ? t.installSwitch : t.install}
          </Button>
        </div>
      ) : !picked ? (
        <p className="mt-3 pl-6 text-xs text-muted-foreground">{t.branchPickFirst}</p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-3 ml-6 rounded-md border border-emerald-500/40 px-3 py-2 text-xs" data-branch-saved={saved}>
          {saved === "started" ? t.installStarted : t.switchSaved}
        </p>
      ) : null}
    </section>
  );
}

/** A finished install stays on the page for a while, or until the person has seen what failed. */
const INSTALLS_SHOWN_MS = 10 * 60_000;
function showInstalls(progress: InstallProgress): boolean {
  if (progress.finishedAt === null) return true;
  if (progress.done.some((item) => !item.ok)) return true;
  return Date.now() - Date.parse(progress.finishedAt) < INSTALLS_SHOWN_MS;
}

export function SetupPage() {
  const pageLang = useLang();
  const { rpc, setup, error, setError, checking, refetch } = useSetup(PAGE_POLL_MS);
  const t = useMessages(messages);
  const navigate = useBbNavigate();
  const fail = (cause: unknown) => setError(errorText(cause));
  // A step's own errors stay in its card until that step's next try; the line
  // under the title is for loading and sync, which a poll clears.
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const stepTry = <T,>(id: string, call: () => Promise<T>): Promise<T> => {
    setStepErrors(({ [id]: _, ...rest }) => rest);
    return call().then(
      (value) => {
        refetch();
        return value;
      },
      (cause: unknown) => {
        setStepErrors((errors) => ({ ...errors, [id]: errorText(cause) }));
        throw cause;
      },
    );
  };
  const counted = (setup?.steps ?? []).filter((step) => step.state !== "later" && shownState(step) !== "skipped");
  const done = counted.filter((step) => step.state === "done").length;
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <h1 className="text-base font-semibold">{t.title}</h1>
          {setup?.configured && counted.length > 0 ? <p className="text-xs text-muted-foreground">{t.progress(done, counted.length)}</p> : null}
        </div>
        <LanguageSwitch />
        <Button size="sm" variant="outline" disabled={checking} onClick={() => refetch(true)}>
          <Icon name={checking ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-4", checking && "animate-spin")} />
          {t.checkAgain}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t.intro}</p>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}

      {setup?.opencodeInstall && setup.opencodeInstall.state !== "ready" ? (
        <p role={setup.opencodeInstall.state === "installing" ? "status" : "alert"} className={cn("mt-3 rounded-lg border px-4 py-2.5 text-sm", setup.opencodeInstall.state === "installing" ? "border-border" : "border-destructive/50 text-destructive")}>
          {render(pageLang, setup.opencodeInstall)}
        </p>
      ) : null}

      {setup === null ? (
        error ? null : <p className="mt-4 text-sm text-muted-foreground">{t.loading}</p>
      ) : !setup.configured ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{t.notSynced}</div>
      ) : setup.steps.length === 0 && !setup.branches ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{t.noSteps}</div>
      ) : (
        <>
          {setup.complete ? (
            <div role="status" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/40 px-4 py-3 text-sm">
              <Icon name="CircleCheck" className="size-5 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.allSet}</p>
                <p className="text-xs text-muted-foreground">{t.ready}</p>
              </div>
              <Button size="sm" onClick={() => navigate.toCompose({ focusPrompt: true })}>
                <Icon name="MessageSquarePlus" className="size-4" />
                {t.start}
              </Button>
            </div>
          ) : null}
          {setup.installs && showInstalls(setup.installs) ? <InstallCard progress={setup.installs} /> : null}
          {setup.branches ? (
            <BranchCard
              branches={setup.branches}
              onChoose={(branch, confirmed, plugins) =>
                rpc.call("branch_choose", { branch, confirmed, plugins }).then(
                  (answer) => {
                    refetch();
                    return answer.chosen === null ? answer.turnsOff : [];
                  },
                  (cause) => {
                    fail(cause);
                    throw cause;
                  },
                )
              }
              onToggle={(id, on) => void rpc.call("branch_toggle", { id, on }).then(() => refetch(), fail)}
            />
          ) : null}
          <ol className="mt-4 flex flex-col gap-3">
            {setup.steps.map((step) => (
              <StepCard
                key={step.id}
                step={step}
                secretStore={setup.secretStore}
                error={stepErrors[step.id] === undefined ? null : stepErrorText(stepErrors[step.id]!, pageLang)}
                onMark={(mark) => void stepTry(step.id, () => rpc.call("setup_mark", { id: step.id, mark })).catch(() => undefined)}
                // The rejection reaches the form, which keeps what was typed to try again.
                onAccount={(login, password) => stepTry(step.id, () => rpc.call("account_set", { id: step.id, login, password, lang: pageLang })).then(() => undefined)}
                onForget={() => void stepTry(step.id, () => rpc.call("account_clear", { id: step.id })).catch(() => undefined)}
                onSecret={(value) => stepTry(step.id, () => rpc.call("secret_set", { name: step.target, value })).then(() => undefined)}
              />
            ))}
          </ol>
        </>
      )}
    </Frame>
  );
}

/** The reminder on the status page while steps are left. */
export function SetupBanner() {
  const { setup } = useSetup(BADGE_POLL_MS);
  const t = useMessages(messages);
  const navigate = useBbNavigate();
  if (!setup?.configured || setup.complete) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm">
      <Icon name="Target" className="size-4 text-amber-600 dark:text-amber-400" />
      <span className="min-w-0 flex-1">{t.left(setup.remaining)}</span>
      <Button
        size="sm"
        onClick={() => navigate.toPluginPanel("status", { subPath: SETUP_SUBPATH })}
      >
        {t.continue}
      </Button>
    </div>
  );
}

/** The sidebar badge of the First run page: steps left. */
export function useSetupBadge(): ExperimentalBadge | null {
  const { setup } = useSetup(BADGE_POLL_MS);
  const t = useMessages(messages);
  if (!setup?.configured || setup.complete || setup.remaining === 0) return null;
  return { count: setup.remaining, tone: "warning", label: t.badge(setup.remaining) };
}

/** The page title in the sidebar, in the language at load time. */
export function setupTitle(lang: "en" | "ru"): string {
  return messages[lang].title;
}
