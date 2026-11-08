// Fleet Kit panels. The status page: build version, the last sync, OpenCode
// model protection, build secrets, and a "Sync now" button. The First run page
// (src/app/setup-page.tsx): the build's setup steps. Data comes from the
// backend over RPC; the backend's "status-changed" signal triggers a refetch.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { OwnAgentsOutcome, Status, Step } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defineMessages, getLang, intlLocale, LanguageSwitch, useLang, useMessages, type Lang } from "@/lib/i18n";
import { render } from "./src/shared/texts";
import { watchBranding } from "./src/app/branding";
import { Frame, Section, SecretRow, STATUS_CHANNEL } from "./src/app/parts";
import { SETUP_SUBPATH, SetupBanner, SetupPage, setupTitle, startsOnSetup, useSetupBadge } from "./src/app/setup-page";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { FirstRunRedirect } from "./src/app/first-run-redirect";
type Outcome = NonNullable<Status["lastSync"]>["outcome"];

const messages = defineMessages(
  {
    never: "never",
    lessThanMinute: "less than a minute",
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} h`,
    inTime: (text: string) => `in ${text}`,
    ago: (text: string) => `${text} ago`,
    outcome: (outcome: Outcome | "none") =>
      ({ ok: "Up to date", changed: "Changes applied", warning: "Applied with warnings", error: "Errors", none: "Not synced yet" })[outcome],
    notInstalled: "OpenCode is not installed.",
    tooOld: (version: string) => `OpenCode ${version} is too old. Update OpenCode to 2.x.`,
    systemPolicy: "system policy",
    userSetting: "user setting",
    modelsOnly: (providers: string, level: string) => `Models: only ${providers} (${level})`,
    modelsUnchecked: "Models: not checked yet.",
    modelsOpen: (providers: string) => `Models are not limited to ${providers}.`,
    loading: "Loading…",
    manifestAt: (url: string) => `Manifest: ${url}`,
    noManifest: "No manifest address yet",
    syncing: "Syncing…",
    syncNow: "Sync now",
    lastSync: (when: string) => `Last sync ${when}`,
    paused: "; syncing is paused",
    next: (when: string) => `; next ${when}`,
    setManifest: "Set the build manifest address:",
    manifestHint: "<https:// URL or file path>",
    outdated: "This build needs a newer Fleet Kit. Until it installs, nothing else from the build is applied.",
    dismiss: "Dismiss",
    secrets: "Secrets",
    lastSyncTitle: "Last sync",
    onlyChanges: "Only changes",
    showAll: "Show all",
    allMatch: "Everything matches the manifest.",
    defaultModel: (model: string) => `Default model: ${model}`,
    version: (version: string) => `Version ${version}`,
    lockedBy: (owner: string, since: string) => `OpenCode configuration is locked by ${owner} since ${since}.`,
    unknownOwner: "unknown",
    resetLock: "Reset lock",
    item: (name: string) => name,
    ownTitle: "Your own agents",
    ownAgents: (names: string) => `Agents: ${names}`,
    ownDelegate: (provider: string, model: string) => `Steps for company systems go to ${provider} with the model ${model}.`,
    ownOn: (when: string) => `On since ${when}. Turn the agents on in Settings → Providers; Fleet Kit no longer turns them off.`,
    ownOff: "Off: Fleet Kit keeps only the build's agents.",
    ownTurnOn: "Turn on…",
    ownTurnOff: "Turn off",
    ownWaiting: "Confirm in the system window…",
    ownRefused: (count: number, until: string | null) => `Windows cancelled or left unanswered: ${count}.${until ? ` The next one can open after ${until}.` : ""}`,
    ownOutcome: (outcome: OwnAgentsOutcome) =>
      ({
        on: "Turned on.",
        off: "Turned off. Fleet Kit turns these agents off at this sync.",
        cancelled: "Not turned on: the system window was cancelled.",
        timeout: "Not turned on: nobody answered the system window.",
        unavailable: "Not turned on: this computer could not show the confirmation window.",
        busy: "Another confirmation window is open. Answer it first.",
        paused: "Not turned on: the last window was cancelled or left unanswered. Try again in 10 minutes.",
        "not-offered": "This build does not offer your own agents.",
      })[outcome],
  },
  {
    never: "ещё не было",
    lessThanMinute: "меньше минуты",
    minutes: (n) => `${n} мин`,
    hours: (n) => `${n} ч`,
    inTime: (text) => `через ${text}`,
    ago: (text) => `${text} назад`,
    outcome: (outcome) =>
      ({ ok: "Всё совпадает", changed: "Изменения применены", warning: "Применено с предупреждениями", error: "Ошибки", none: "Ещё не сверялся" })[outcome],
    notInstalled: "OpenCode не установлен.",
    tooOld: (version) => `OpenCode ${version} устарел. Обновите OpenCode до 2.x.`,
    systemPolicy: "системная политика",
    userSetting: "настройка пользователя",
    modelsOnly: (providers, level) => `Модели: только ${providers} (${level})`,
    modelsUnchecked: "Модели: ещё не проверены.",
    modelsOpen: (providers) => `Модели не ограничены провайдерами ${providers}.`,
    loading: "Загрузка…",
    manifestAt: (url) => `Манифест: ${url}`,
    noManifest: "Адрес манифеста ещё не задан",
    syncing: "Сверяю…",
    syncNow: "Сверить сейчас",
    lastSync: (when) => `Последняя сверка: ${when}`,
    paused: "; сверка приостановлена",
    next: (when) => `; следующая ${when}`,
    setManifest: "Задайте адрес манифеста сборки:",
    manifestHint: "<адрес https:// или путь к файлу>",
    outdated: "Сборке нужен более новый Fleet Kit. Пока он не установится, остальное из сборки не применяется.",
    dismiss: "Скрыть",
    secrets: "Секреты",
    lastSyncTitle: "Последняя сверка",
    onlyChanges: "Только изменения",
    showAll: "Показать всё",
    allMatch: "Всё совпадает с манифестом.",
    defaultModel: (model) => `Модель по умолчанию: ${model}`,
    version: (version) => `Версия ${version}`,
    lockedBy: (owner, since) => `Конфигурацию OpenCode держит ${owner} с ${since}.`,
    unknownOwner: "неизвестно кто",
    resetLock: "Снять блокировку",
    item: (name) => ITEM_RU[name] ?? name,
    ownTitle: "Свои агенты",
    ownAgents: (names) => `Агенты: ${names}`,
    ownDelegate: (provider, model) => `Шаги в корпоративных системах уходят агенту ${provider} с моделью ${model}.`,
    ownOn: (when) => `Включено с ${when}. Самих агентов включите в Settings → Providers; Fleet Kit их больше не выключает.`,
    ownOff: "Выключено: Fleet Kit оставляет только агентов сборки.",
    ownTurnOn: "Включить…",
    ownTurnOff: "Выключить",
    ownWaiting: "Подтвердите в системном окне…",
    ownRefused: (count, until) => `Окон отменено или оставлено без ответа: ${count}.${until ? ` Следующее можно открыть после ${until}.` : ""}`,
    ownOutcome: (outcome) =>
      ({
        on: "Включено.",
        off: "Выключено. Fleet Kit выключит этих агентов на этой сверке.",
        cancelled: "Не включено: в системном окне нажата отмена.",
        timeout: "Не включено: системное окно осталось без ответа.",
        unavailable: "Не включено: этот компьютер не смог показать окно подтверждения.",
        busy: "Уже открыто другое окно подтверждения. Сначала ответьте в нём.",
        paused: "Не включено: прошлое окно отменено или осталось без ответа. Повторить можно через 10 минут.",
        "not-offered": "Сборка не предлагает своих агентов.",
      })[outcome],
  },
);
type Texts = (typeof messages)["en"];

/** Russian for the fixed item names the server reports; plugin ids and paths stay as they are. */
const ITEM_RU: Record<string, string> = {
  manifest: "манифест",
  plugins: "плагины",
  marketplaces: "каталоги плагинов",
  settings: "настройки",
  version: "версия bb",
  "secret resolver": "подстановка ключей",
  "model list": "список моделей",
  models: "модели",
  agents: "агенты",
  "ai-services": "AI-сервисы",
  "thread-title": "названия тредов",
  "commit-message": "сообщения коммитов",
  voice: "голос",
  sidebar: "боковая панель",
  "sidebar.visiblePluginPanels": "пункты боковой панели",
  "sidebar.hiddenFooterItems": "кнопки внизу панели",
};

function useStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("status").then((value) => {
      setStatus(value);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => refetch(), [refetch]);
  useRealtime(STATUS_CHANNEL, refetch);
  return { rpc, status, error, report, refetch };
}

function relative(t: Texts, iso: string | null): string {
  if (iso === null) return t.never;
  const delta = Date.parse(iso) - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const text = minutes < 1 ? t.lessThanMinute : minutes < 60 ? t.minutes(minutes) : t.hours(Math.round(minutes / 60));
  return delta >= 0 ? t.inTime(text) : t.ago(text);
}

function OutcomeBadge({ outcome }: { outcome: Outcome | "none" }) {
  const t = useMessages(messages);
  const tone =
    outcome === "error"
      ? "border-destructive/40 text-destructive"
      : outcome === "warning"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs", tone)}>{t.outcome(outcome)}</span>
  );
}

const STEP_ICON: Record<Step["outcome"], { name: string; className: string }> = {
  ok: { name: "Check", className: "text-muted-foreground" },
  changed: { name: "ArrowUp", className: "text-foreground" },
  skipped: { name: "Minus", className: "text-muted-foreground" },
  warning: { name: "AlertTriangle", className: "text-amber-600 dark:text-amber-400" },
  error: { name: "CircleX", className: "text-destructive" },
};

function StepRow({ step }: { step: Step }) {
  const t = useMessages(messages);
  const lang = useLang();
  const icon = STEP_ICON[step.outcome];
  return (
    <li className="flex gap-2 py-1.5">
      <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} />
      <div className="min-w-0">
        <span className="font-medium">{t.item(step.item)}</span>
        <span className="text-muted-foreground"> {render(lang, step)}</span>
      </div>
    </li>
  );
}

function ModelsLine({ opencode }: { opencode: NonNullable<Status["opencode"]> }) {
  const t = useMessages(messages);
  const lang = useLang();
  const providers = opencode.allowedProviders.join(", ");
  if (opencode.install && opencode.install.state !== "ready") return <p className={opencode.install.state === "installing" ? "text-muted-foreground" : "text-destructive"}>{render(lang, opencode.install)}</p>;
  if (!opencode.installed) return <p className="text-amber-600 dark:text-amber-400">{t.notInstalled}</p>;
  if (opencode.version !== null && !/^v?2\./.test(opencode.version)) {
    return <p className="text-amber-600 dark:text-amber-400">{t.tooOld(opencode.version)}</p>;
  }
  if (opencode.models.state === "verified") {
    const level = opencode.protection === "system-policy" ? t.systemPolicy : t.userSetting;
    return (
      <p className="flex items-center gap-2">
        <Icon name="SecurityCheck" className="size-4 text-muted-foreground" />
        {t.modelsOnly(providers, level)}
      </p>
    );
  }
  if (opencode.models.state === "unchecked") return <p className="text-muted-foreground">{t.modelsUnchecked}</p>;
  return (
    <p className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" />
      <span>
        {t.modelsOpen(providers)} {render(lang, { message: opencode.models.message })}
      </span>
    </p>
  );
}

function OwnAgentsSection({ own, onChange }: { own: NonNullable<Status["ownAgents"]>; onChange: () => void }) {
  const t = useMessages(messages);
  const lang: Lang = useLang();
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const toggle = (on: boolean) => {
    setBusy(true);
    setNote(on ? t.ownWaiting : null);
    rpc.call("own_agents_set", { on, lang }).then(
      (answer) => {
        setNote(t.ownOutcome(answer.outcome));
        onChange();
      },
      (cause: unknown) => setNote(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setBusy(false));
  };
  return (
    <Section
      title={own.title ?? t.ownTitle}
      icon="User"
      aside={
        <Button size="sm" variant={own.on ? "outline" : "default"} disabled={busy} onClick={() => toggle(!own.on)}>
          {own.on ? t.ownTurnOff : t.ownTurnOn}
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5">
        <p className={own.on ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
          {own.on ? t.ownOn(own.at ? new Date(own.at).toLocaleString(intlLocale(lang)) : "—") : t.ownOff}
        </p>
        <p className="text-muted-foreground">{t.ownAgents(own.providers.map((entry) => entry.name).join(", "))}</p>
        {own.delegate ? <p className="text-muted-foreground">{t.ownDelegate(own.delegate.provider, own.delegate.model)}</p> : null}
        <p className="mt-1 flex items-start gap-2 whitespace-pre-line rounded-md border border-amber-500/40 px-3 py-2">
          <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{own.warning}</span>
        </p>
        {own.refusals ? (
          <p className="text-muted-foreground">{t.ownRefused(own.refusals, own.retryAt ? new Date(own.retryAt).toLocaleTimeString(intlLocale(lang)) : null)}</p>
        ) : null}
        {note ? <p role="status" className="text-muted-foreground">{note}</p> : null}
      </div>
    </Section>
  );
}

function FleetKitPage() {
  const { rpc, status, error, report, refetch } = useStatus();
  const [showAll, setShowAll] = useState(false);
  const t = useMessages(messages);
  const lang: Lang = useLang();
  if (status === null) {
    return (
      <Frame>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">{t.loading}</p>}
      </Frame>
    );
  }
  const last = status.lastSync;
  const visible = (last?.steps ?? []).filter((step) => showAll || (step.outcome !== "ok" && step.outcome !== "skipped"));
  const lock = status.opencode?.lock;
  const lockStuck = lock && Date.now() > (lock.resetAfter ? Date.parse(lock.resetAfter) : Date.parse(lock.since) + 120_000);
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-3">
        {/* The title keeps 16rem: on a narrow panel the controls wrap below it instead of truncating the manifest address. */}
        <div className="min-w-64 flex-1">
          <h1 className="text-base font-semibold">{last?.build ? `${last.build.name} ${last.build.version}` : "Fleet Kit"}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {status.configured ? t.manifestAt(status.manifestUrl) : t.noManifest}
          </p>
        </div>
        <LanguageSwitch />
        <OutcomeBadge outcome={last?.outcome ?? "none"} />
        <Button
          size="sm"
          disabled={!status.configured || status.syncing}
          onClick={() => rpc.call("sync_now").then(refetch, report)}
        >
          <Icon name={status.syncing ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-4", status.syncing && "animate-spin")} />
          {status.syncing ? t.syncing : t.syncNow}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t.lastSync(relative(t, last?.finishedAt ?? null))}
        {status.paused ? t.paused : status.nextSyncAt ? t.next(relative(t, status.nextSyncAt)) : ""}
      </p>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}

      {!status.configured ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          {t.setManifest} <code>bb plugin config fleet-kit set manifestUrl {t.manifestHint}</code>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        <SetupBanner />
        {last?.fleetKitOutdated ? (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm">
            <Icon name="AlertTriangle" className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">{t.outdated}</span>
          </div>
        ) : null}
        {status.notices.map((notice) => (
          <div key={notice.id} className="flex items-center gap-2 rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm">
            <Icon name="Info" className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">{render(lang, notice)}</span>
            <Button variant="ghost" size="sm" onClick={() => rpc.call("notice_dismiss", { id: notice.id }).then(refetch, report)}>
              {t.dismiss}
            </Button>
          </div>
        ))}

        {status.secrets.length > 0 ? (
          <Section title={t.secrets} icon="Lock">
            <ul className="divide-y divide-border">
              {status.secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  secret={secret}
                  store={status.secretStore}
                  onSave={(value) =>
                    rpc.call("secret_set", { name: secret.name, value }).then(refetch, (cause) => {
                      // Shown above; the rejection keeps the typed key in the field.
                      report(cause);
                      throw cause;
                    })
                  }
                  onClear={() => rpc.call("secret_clear", { name: secret.name }).then(refetch, report)}
                />
              ))}
            </ul>
          </Section>
        ) : null}

        {status.opencode ? (
          <Section title="OpenCode" icon="Bot">
            <div className="flex flex-col gap-1.5">
              <ModelsLine opencode={status.opencode} />
              {status.opencode.defaultModel ? <p className="text-muted-foreground">{t.defaultModel(status.opencode.defaultModel)}</p> : null}
              {status.opencode.version ? <p className="text-muted-foreground">{t.version(status.opencode.version)}</p> : null}
              {status.opencode.configFile ? <p className="truncate text-xs text-muted-foreground">{status.opencode.configFile}</p> : null}
              {status.opencode.lock ? (
                <div className="mt-1 flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <Icon name="Lock" className="size-4" />
                  <span className="flex-1">
                    {t.lockedBy(
                      status.opencode.lock.owner === "unknown" ? t.unknownOwner : status.opencode.lock.owner,
                      new Date(status.opencode.lock.since).toLocaleTimeString(intlLocale(lang)),
                    )}
                  </span>
                  {lockStuck ? (
                    <Button variant="outline" size="sm" onClick={() => rpc.call("lock_reset").then(refetch, report)}>
                      {t.resetLock}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {status.ownAgents ? <OwnAgentsSection own={status.ownAgents} onChange={refetch} /> : null}

        {last ? (
          <Section
            title={t.lastSyncTitle}
            icon="ListTodo"
            aside={
              <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
                {showAll ? t.onlyChanges : t.showAll}
              </Button>
            }
          >
            {visible.length === 0 ? (
              <p className="text-muted-foreground">{t.allMatch}</p>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((step, index) => (
                  <StepRow key={`${step.area}:${step.item}:${index}`} step={step} />
                ))}
              </ul>
            )}
          </Section>
        ) : null}
      </div>
    </Frame>
  );
}

/** The panel's two views: the First run steps and the build's status. */
const STATUS_SUBPATH = "sync";

function Tabs({ view }: { view: "setup" | "status" }) {
  const navigate = useBbNavigate();
  const lang = useLang();
  const tab = (id: "setup" | "status", title: string, subPath: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      data-tab={id}
      onClick={() => (view === id ? undefined : navigate.toPluginPanel(PANEL_PATH, { subPath }))}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
        view === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {title}
    </button>
  );
  return (
    <div role="tablist" className="mx-auto flex w-full max-w-3xl gap-1 border-b border-border px-4 pt-3">
      {tab("setup", setupTitle(lang), SETUP_SUBPATH)}
      {tab("status", lang === "ru" ? "Состояние сборки" : "Build status", STATUS_SUBPATH)}
    </div>
  );
}

/**
 * One sidebar entry for both views. Its root opens First run until every
 * step is done (and on a fresh bb, before the build is read), then the status.
 */
function FleetKitPanel({ subPath }: PluginNavPanelProps) {
  const first = subPath.split("/")[0] ?? "";
  const view = first === SETUP_SUBPATH ? "setup" : first === STATUS_SUBPATH ? "status" : startsOnSetup() ? "setup" : "status";
  return (
    <>
      <Tabs view={view} />
      {view === "setup" ? <SetupPage /> : <FleetKitPage />}
    </>
  );
}

const PANEL_PATH = "status";

export default definePluginApp((app) => {
  // The build's name and logo. A content script and not an overlay: bb's onboarding screen, which carries its logo,
  // replaces the app shell, so overlays only appear after it. A content script has no RPC hook, so it asks the server.
  app.contentScripts.register({
    id: "branding",
    mount({ pluginId }) {
      return watchBranding(document, async () => {
        const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/branding`);
        if (!response.ok) throw new Error(`Branding: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
      });
    },
  });
  // Once per launch, from the new-thread screen: First run while steps are left.
  app.slots.experimental_appOverlay({ id: "first-run", component: FirstRunRedirect });
  // /plugins/fleet-kit/status opens First run while steps are left; /status/setup and /status/sync open a view.
  app.slots.navPanel({
    id: "fleet-kit",
    title: "Fleet Kit",
    icon: "PackageReceive",
    path: PANEL_PATH,
    component: FleetKitPanel,
    experimental_useBadge: useSetupBadge,
  });
});
