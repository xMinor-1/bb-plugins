// Fleet Kit panel: build version, the last sync, OpenCode model protection,
// build secrets, and a "Sync now" button. Data comes from the backend over
// RPC; the backend's "status-changed" signal triggers a refetch.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Status, Step } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { defineMessages, intlLocale, LanguageSwitch, useLang, useMessages, type Lang } from "@/lib/i18n";
import { render, storeName } from "./src/shared/texts";

const STATUS_CHANNEL = "status-changed";
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
    savedIn: (store: string) => `Saved in ${store}`,
    notSet: "Not set",
    replace: "Replace",
    remove: "Remove",
    pasteValue: "Paste the value",
    save: "Save",
    cancel: "Cancel",
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
    savedIn: (store) => `Сохранён: ${store}`,
    notSet: "Не задан",
    replace: "Заменить",
    remove: "Удалить",
    pasteValue: "Вставьте значение",
    save: "Сохранить",
    cancel: "Отмена",
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

function Section({ title, icon, children, aside }: { title: string; icon: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name={icon} className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium">{title}</h2>
        {aside}
      </header>
      <div className="px-4 py-3 text-sm">{children}</div>
    </section>
  );
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

function SecretRow({ secret, store, onSave, onClear }: {
  secret: Status["secrets"][number];
  store: string;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const t = useMessages(messages);
  const lang = useLang();
  const [editing, setEditing] = useState(!secret.set);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => setEditing(!secret.set), [secret.set]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value.trim() === "" || pending) return;
    setPending(true);
    try {
      await onSave(value);
      setValue("");
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <Icon name={secret.set ? "Lock" : "SquareUnlock02"} className={cn("size-4", secret.set ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")} />
        <span className="flex-1 font-medium">{secret.title}</span>
        <span className="text-xs text-muted-foreground">{secret.set ? t.savedIn(storeName(store, lang)) : t.notSet}</span>
        {secret.set && !editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t.replace}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void onClear()}>
              {t.remove}
            </Button>
          </>
        ) : null}
      </div>
      {secret.hint ? <p className="mt-1 pl-6 text-xs text-muted-foreground">{secret.hint}</p> : null}
      {editing ? (
        <form onSubmit={submit} className="mt-2 flex items-center gap-2 pl-6">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t.pasteValue}
            aria-label={secret.title}
          />
          <Button type="submit" size="sm" disabled={pending || value.trim() === ""}>
            {t.save}
          </Button>
          {secret.set ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t.cancel}
            </Button>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

function ModelsLine({ opencode }: { opencode: NonNullable<Status["opencode"]> }) {
  const t = useMessages(messages);
  const lang = useLang();
  const providers = opencode.allowedProviders.join(", ");
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
                  onSave={(value) => rpc.call("secret_set", { name: secret.name, value }).then(refetch, report)}
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

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{children}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet-kit",
    title: "Fleet Kit",
    icon: "PackageReceive",
    path: "status",
    component: FleetKitPage,
  });
});
