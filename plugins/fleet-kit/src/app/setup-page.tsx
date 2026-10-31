// The "First run" page: the build's setup steps on one page, each done or not,
// with a button to the plugin's own page or the secret field right here. The
// page asks again whenever the person comes back, since steps are done on
// other plugins' pages. Also the reminder on the status page and the badge in
// the sidebar, while steps are left.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import type { Setup, SetupMark, SetupStep } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defineMessages, LanguageSwitch, pluralRu, useLang, useMessages } from "@/lib/i18n";
import { errorText, Frame, SecretInput, STATUS_CHANNEL, useSavedIn } from "./parts";

/** The panel path of this page: the installer opens bb on /plugins/fleet-kit/setup. */
export const SETUP_PANEL = "setup";
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
      ({ done: "Done", todo: "To do", problem: "Didn't work", installing: "Installing the plugin", later: "Coming later", skipped: "Skipped" })[state],
    manual: "This plugin cannot report its state: mark the step yourself once it is done.",
    noAnswer: "The plugin did not answer. Open its page or check again.",
    installFailed: "The plugin did not install. Details are on the Fleet Kit page.",
    installing: "Fleet Kit is installing the plugin; the step appears here when it is ready.",
    later: "The plugin is not in the build yet.",
    open: "Open",
    markDone: "Mark as done",
    notDone: "Not done yet",
    skip: "Skip",
    unskip: "Do it after all",
    replace: "Replace",
    left: (n: number) => `First run: ${n} ${n === 1 ? "step" : "steps"} left`,
    continue: "Continue",
    badge: (n: number) => `${n} setup ${n === 1 ? "step" : "steps"} left`,
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
      ({ done: "Готово", todo: "Нужно сделать", problem: "Не получилось", installing: "Плагин ещё ставится", later: "Появится позже", skipped: "Пропущено" })[state],
    manual: "Этот плагин не сообщает о готовности: когда сделаете шаг, отметьте его сами.",
    noAnswer: "Плагин не ответил. Откройте его страницу или проверьте снова.",
    installFailed: "Плагин не установился. Подробности на странице пульта.",
    installing: "Пульт ставит плагин, шаг станет доступен, когда он будет готов.",
    later: "Плагина ещё нет в сборке.",
    open: "Открыть",
    markDone: "Отметить готовым",
    notDone: "Ещё не готово",
    skip: "Пропустить",
    unskip: "Всё-таки сделать",
    replace: "Заменить",
    left: (n) => `Первый запуск: осталось ${n} ${stepsRu(n)}`,
    continue: "Продолжить",
    badge: (n) => `Осталось шагов настройки: ${n}`,
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
  later: { name: "Clock", className: "text-muted-foreground" },
  skipped: { name: "Minus", className: "text-muted-foreground" },
};

function explanation(t: Texts, step: SetupStep): string | null {
  if (shownState(step) === "skipped") return null;
  if (step.summary !== null && step.state !== "installing" && step.state !== "later") return step.summary;
  if (step.state === "installing") return t.installing;
  if (step.state === "later") return t.later;
  if (step.reason === "install-failed") return t.installFailed;
  if (step.reason === "no-answer") return t.noAnswer;
  if (step.reason === "manual" && step.state !== "done") return t.manual;
  return null;
}

function StepCard({ step, secretStore, onMark, onSecret }: {
  step: SetupStep;
  secretStore: string;
  onMark: (mark: SetupMark | null) => void;
  onSecret: (value: string) => Promise<void>;
}) {
  const t = useMessages(messages);
  const savedIn = useSavedIn();
  const [replacing, setReplacing] = useState(false);
  const state = shownState(step);
  const icon = STATE_ICON[state];
  const why = explanation(t, step);
  const actionable = state !== "later" && state !== "installing";
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
    </li>
  );
}

export function SetupPage() {
  const { rpc, setup, error, setError, checking, refetch } = useSetup(PAGE_POLL_MS);
  const t = useMessages(messages);
  const navigate = useBbNavigate();
  const fail = (cause: unknown) => setError(errorText(cause));
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

      {setup === null ? (
        error ? null : <p className="mt-4 text-sm text-muted-foreground">{t.loading}</p>
      ) : !setup.configured ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{t.notSynced}</div>
      ) : setup.steps.length === 0 ? (
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
          <ol className="mt-4 flex flex-col gap-3">
            {setup.steps.map((step) => (
              <StepCard
                key={step.id}
                step={step}
                secretStore={setup.secretStore}
                onMark={(mark) => void rpc.call("setup_mark", { id: step.id, mark }).then(() => refetch(), fail)}
                onSecret={(value) => rpc.call("secret_set", { name: step.target, value }).then(() => refetch(), fail)}
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
      <Button size="sm" onClick={() => navigate.toPluginPanel(SETUP_PANEL)}>
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
