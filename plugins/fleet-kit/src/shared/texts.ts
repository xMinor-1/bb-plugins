// Texts the server writes for the panel — sync steps and notices — in
// English and Russian.
//
// Plain TypeScript with no React, so both sides import it: the server stores
// each text as a code with its parameters, plus an English copy for logs and
// the CLI; the panel shows it in the person's language. Text that comes from
// elsewhere (bb's errors, manifest problems, OpenCode's checks) travels as the
// "raw" code and is shown as is, unless RAW_RU knows its Russian.
export type Lang = "en" | "ru";
type Params = Record<string, string | number>;

/** A text as the server stores it. */
export interface Said {
  code: string;
  params: Params;
  /** The English text, for the CLI, logs and older panels. */
  message: string;
}

const when = (iso: string | number, lang: Lang) =>
  new Date(iso).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" });

function ruPlural(n: number, one: string, few: string, many: string): string {
  const lastTwo = Math.abs(n) % 100;
  const last = Math.abs(n) % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
const times = (n: number) => `${n} ${ruPlural(n, "раз", "раза", "раз")}`;

/** Names of secret stores as the server labels them. */
export function storeName(label: string, lang: Lang): string {
  if (lang === "en") return label;
  if (label === "macOS Keychain") return "Связка ключей macOS";
  if (label === "Windows Credential Manager") return "Диспетчер учётных данных Windows";
  const file = /^file \((.*)\)$/.exec(label);
  return file ? `файл (${file[1]})` : label;
}

const en = {
  raw: (p: { text: string }) => p.text,
  manifestUnreadable: (p: { error: string }) => `Could not read the manifest: ${p.error}`,
  manifestRead: (p: { name: string; version: string }) => `Read ${p.name} ${p.version}.`,
  manifestHasErrors: () => "The manifest has errors, so nothing else was applied.",
  needsNewerSoon: () => "This build needs a newer Fleet Kit. It installs after this sync; the rest of the build applies then.",
  needsNewerNone: () => "This build needs a newer Fleet Kit, and none is offered yet; nothing else was applied.",
  bbTooOld: (p: { need: string; have: string }) => `This build needs bb ${p.need} or newer; this bb is ${p.have}. Update bb.`,
  marketplaceAdded: () => "Added the marketplace.",
  secretMissing: (p: { title: string }) => `${p.title} is not set. Enter it in the Fleet Kit panel.`,
  secretStoreUnreadable: (p: { store: string; error: string }) => `Could not read ${p.store}: ${p.error}`,

  selfUpdateCheckFailed: (p: { error: string }) => `Could not check for a Fleet Kit update: ${p.error}`,
  selfNotUpdating: (p: { problem: string }) => `Not updating Fleet Kit: ${p.problem}.`,
  selfNotPinned: () => "Not updating Fleet Kit: its source is not pinned with @semver:<range> or @ref:<name>.",
  selfOtherSource: () => "Fleet Kit is installed from a different source than the manifest lists. Reinstall it with the installer.",
  selfUpdateRunning: () => "A Fleet Kit update is already running.",
  selfUpdateJobsUnknown: () => "Not updating Fleet Kit now: could not see whether an update is already running.",
  selfUpdateGaveUp: (p: { version: string; attempts: number; retry: string }) =>
    `Fleet Kit ${p.version} did not install after ${p.attempts} tries; the next try is after ${when(p.retry, "en")}.`,
  selfUpdateAvailable: (p: { version: string }) => `Fleet Kit ${p.version} is available; it installs after this sync.`,

  bbSettingUnknown: (p: { key: string }) => `bb has no general setting "${p.key}".`,
  bbSettingType: (p: { key: string; type: string }) => `bb expects a ${p.type} for "${p.key}".`,
  bbSettingSet: (p: { value: string }) => `Set to ${p.value}.`,

  aiOff: () => "Turned off.",
  aiAutomatic: () => "Set to automatic: bb picks a ready service.",
  aiService: (p: { service: string }) => `Set to ${p.service}.`,
  aiServiceMissing: (p: { service: string }) => `No service "${p.service}" is registered for this task yet; turned off until it is.`,
  aiServiceAmbiguous: (p: { service: string; plugins: string }) =>
    `Several plugins register "${p.service}" (${p.plugins}); name the plugin in the manifest. Turned off meanwhile.`,

  agentsNoneHere: (p: { allowed: string }) => `None of the allowed agents (${p.allowed}) exists in this bb, so no agent was turned off.`,
  agentAllowedMissing: () => "Allowed by the build, but this bb has no such agent.",
  agentEnabled: () => "Turned on: the build allows it.",
  agentDisabled: (p: { allowed: string }) => `Turned off: the build allows only ${p.allowed}.`,
  agentDisabledAgain: (p: { allowed: string }) => `Was turned on by hand; turned off again: the build allows only ${p.allowed}.`,

  pluginPlanned: () => "Planned; not installed yet.",
  pluginKept: () => "No longer in the build; kept. List it in removePlugins to remove it.",
  pluginBundled: () => "Bundled with bb; Fleet Kit never removes it.",
  pluginIdBundled: () => "This id belongs to a plugin bundled with bb; pick another id.",
  pluginRemoved: () => "Removed: the build lists it in removePlugins.",
  pluginRemoveFailed: (p: { error: string }) => `Could not remove: ${p.error}`,
  installed: (p: { version: string }) => `Installed ${p.version}.`,
  installTimedOut: (p: { seconds: number }) => `Installing did not finish within ${p.seconds} s; the next sync checks the result.`,
  enabled: () => "Enabled.",
  updated: (p: { version: string }) => (p.version ? `Updated to ${p.version}.` : "Updated to the latest compatible version."),
  updateRolledBack: () => "The update failed and was rolled back.",
  updateNotApplied: () => "The update did not apply.",
  upToDate: (p: { version: string }) => `Up to date (${p.version}).`,
  noSuchSetting: (p: { key: string }) => `It has no setting "${p.key}".`,
  secretSettingSkipped: (p: { key: string }) => `"${p.key}" is a secret setting; Fleet Kit does not set it.`,
  settingsApplied: (p: { keys: string }) => `Settings applied: ${p.keys}.`,
  settingsRestoreFailed: (p: { error: string }) => `Could not restore its previous settings: ${p.error}`,

  reinstalled: (p: { version: string }) => `Reinstalled ${p.version} from the manifest's source.`,
  stillInstalling: () => "bb is still installing it; the next sync checks the result.",
  jobsUnknown: () => "Could not see whether bb is still installing it; the next sync checks again.",
  switchStillInstalling: () => "bb is still installing it from the manifest's source; the next sync checks the result.",
  switchListUnknown: (p: { error: string }) =>
    `Installing it from the manifest's source did not finish (${p.error}), and bb's plugin list could not be read; the next sync checks again.`,
  switchOtherSource: (p: { error: string; source: string }) =>
    `Installing it from the manifest's source did not finish (${p.error}), and bb now lists it from ${p.source}; left as it is.`,
  switchRolledBack: (p: { error: string; next: string }) =>
    `Could not install it from the manifest's source (${p.error}); the previous source is back. The next try is ${p.next ? `after ${when(p.next, "en")}` : "at the next sync"}.`,
  switchRollbackRunning: (p: { error: string }) =>
    `Could not install it from the manifest's source (${p.error}); bb is still putting the previous source back, and the next sync checks the result.`,
  switchWaiting: (p: { attempts: number; next: string }) =>
    `Kept on its previous source: switching to the manifest's source failed ${p.attempts} time(s); the next try is after ${when(p.next, "en")}.`,
  putBackWaiting: (p: { attempts: number; next: string }) =>
    `Put back on its previous source: switching to the manifest's source failed ${p.attempts} time(s); the next try is after ${when(p.next, "en")}.`,
  rollbackRunning: () => "bb is still putting its previous source back; the next sync checks the result.",
  abandonedListUnknown: () => "No longer in the build, and bb's plugin list could not be read to finish its source switch; the next sync checks again.",
  abandonedKept: (p: { source: string }) => `No longer in the build; its unfinished source switch left it installed from ${p.source}, and it is kept.`,
  abandonedInstalling: () => "No longer in the build; bb is still installing it, and the next sync checks the result.",
  abandonedJobsUnknown: () => "No longer in the build; could not see whether bb is still installing it, and the next sync checks again.",
  abandonedRollbackRunning: () => "No longer in the build; bb is still putting its previous source back, and the next sync checks the result.",
  abandonedPutBack: () => "No longer in the build; put back on its previous source, which an unfinished source switch had removed.",

  opencodeMissing: () => "OpenCode is not installed, so its models are not configured.",
  opencodeUnsupported: (p: { version: string }) => `OpenCode ${p.version} is not supported. Update OpenCode to 2.x.`,
  opencodeTooOld: (p: { version: string }) => `OpenCode ${p.version} is too old for this build. Update OpenCode to 2.x.`,
  previousConfigCleaned: () => "Removed Fleet Kit's settings from the previous OpenCode configuration.",
  previousConfigCleanFailed: (p: { error: string }) => `Could not clean the previous configuration: ${p.error}`,
  configUpdated: (p: { backup: string }) => (p.backup ? `Updated; the original is saved as ${p.backup}.` : "Updated."),
  resolverUpdated: (p: { store: string }) => `Updated the OpenCode plugin that reads keys from ${p.store}.`,
  modelPickerDirectory: (p: { directory: string }) =>
    `bb's model picker reads the default OpenCode configuration, not ${p.directory}. Start bb with OPENCODE_CONFIG_DIR=${p.directory} so the picker shows the build's models; threads already use the directory.`,

  noticeReinstalled: (p: { plugin: string }) => `${p.plugin} was reinstalled from a new source. Enter its secret settings again.`,
  noticePutBack: (p: { plugin: string }) =>
    `${p.plugin} could not switch to its new source and was put back on the previous one. Enter its secret settings again.`,
  noticeReinstalledDuringSwitch: (p: { plugin: string }) => `${p.plugin} was reinstalled during a source switch. Enter its secret settings again.`,
  noticeAgentDisabled: (p: { agent: string; allowed: string }) =>
    `The agent ${p.agent} was turned on, but this build allows only ${p.allowed}; Fleet Kit turned it off again.`,
};

type Catalog = typeof en;
export type TextCode = keyof Catalog;

const ru: Catalog = {
  raw: (p) => RAW_RU[p.text.replace(/\.+$/, ".")] ?? p.text,
  manifestUnreadable: (p) => `Не удалось прочитать манифест: ${p.error}`,
  manifestRead: (p) => `Прочитан манифест ${p.name} ${p.version}.`,
  manifestHasErrors: () => "В манифесте ошибки, поэтому больше ничего не применено.",
  needsNewerSoon: () => "Сборке нужен более новый Fleet Kit. Он установится после этой сверки, остальное применится тогда.",
  needsNewerNone: () => "Сборке нужен более новый Fleet Kit, но его пока нет; больше ничего не применено.",
  bbTooOld: (p) => `Сборке нужен bb ${p.need} или новее, а здесь ${p.have}. Обновите bb.`,
  marketplaceAdded: () => "Каталог плагинов добавлен.",
  secretMissing: (p) => `Не задан секрет «${p.title}». Введите его в панели Fleet Kit.`,
  secretStoreUnreadable: (p) => `Не удалось прочитать хранилище «${storeName(p.store, "ru")}»: ${p.error}`,

  selfUpdateCheckFailed: (p) => `Не удалось проверить обновление Fleet Kit: ${p.error}`,
  selfNotUpdating: (p) => `Fleet Kit не обновляется: ${p.problem}.`,
  selfNotPinned: () => "Fleet Kit не обновляется: его источник не закреплён через @semver:<диапазон> или @ref:<имя>.",
  selfOtherSource: () => "Fleet Kit стоит не из того источника, что указан в манифесте. Переустановите его установщиком.",
  selfUpdateRunning: () => "Обновление Fleet Kit уже идёт.",
  selfUpdateJobsUnknown: () => "Fleet Kit сейчас не обновляется: не удалось узнать, не идёт ли уже обновление.",
  selfUpdateGaveUp: (p) => `Fleet Kit ${p.version} не установился и после ${p.attempts} попыток; следующая попытка — после ${when(p.retry, "ru")}.`,
  selfUpdateAvailable: (p) => `Доступен Fleet Kit ${p.version}; он установится после этой сверки.`,

  bbSettingUnknown: (p) => `В bb нет общей настройки «${p.key}».`,
  bbSettingType: (p) => `Для «${p.key}» bb ждёт значение типа ${p.type}.`,
  bbSettingSet: (p) => `Установлено: ${p.value}.`,

  aiOff: () => "Выключено.",
  aiAutomatic: () => "Автоматически: bb выбирает готовый сервис.",
  aiService: (p) => `Выбран сервис ${p.service}.`,
  aiServiceMissing: (p) => `Сервис «${p.service}» для этой задачи пока не зарегистрирован; до тех пор задача выключена.`,
  aiServiceAmbiguous: (p) => `Сервис «${p.service}» регистрируют несколько плагинов (${p.plugins}); укажите плагин в манифесте. Пока задача выключена.`,

  agentsNoneHere: (p) => `Ни одного из разрешённых агентов (${p.allowed}) в этом bb нет, поэтому ни один агент не выключен.`,
  agentAllowedMissing: () => "Разрешён сборкой, но такого агента в этом bb нет.",
  agentEnabled: () => "Включён: сборка его разрешает.",
  agentDisabled: (p) => `Выключен: сборка разрешает только ${p.allowed}.`,
  agentDisabledAgain: (p) => `Был включён вручную и снова выключен: сборка разрешает только ${p.allowed}.`,

  pluginPlanned: () => "Запланирован, пока не ставится.",
  pluginKept: () => "Больше не входит в сборку, но оставлен. Чтобы снять, укажите его в removePlugins.",
  pluginBundled: () => "Встроен в bb, Fleet Kit его не снимает.",
  pluginIdBundled: () => "Этот id занят встроенным плагином bb; выберите другой.",
  pluginRemoved: () => "Снят: сборка указывает его в removePlugins.",
  pluginRemoveFailed: (p) => `Не удалось снять: ${p.error}`,
  installed: (p) => `Установлен ${p.version}.`,
  installTimedOut: (p) => `Установка не завершилась за ${p.seconds} с; следующая сверка проверит результат.`,
  enabled: () => "Включён.",
  updated: (p) => (p.version ? `Обновлён до ${p.version}.` : "Обновлён до последней совместимой версии."),
  updateRolledBack: () => "Обновление не удалось и откатилось.",
  updateNotApplied: () => "Обновление не применилось.",
  upToDate: (p) => `Актуален (${p.version}).`,
  noSuchSetting: (p) => `У него нет настройки «${p.key}».`,
  secretSettingSkipped: (p) => `«${p.key}» — секретная настройка, Fleet Kit её не задаёт.`,
  settingsApplied: (p) => `Применены настройки: ${p.keys}.`,
  settingsRestoreFailed: (p) => `Не удалось вернуть прежние настройки: ${p.error}`,

  reinstalled: (p) => `Переустановлен ${p.version} из источника манифеста.`,
  stillInstalling: () => "bb ещё ставит его; следующая сверка проверит результат.",
  jobsUnknown: () => "Не удалось узнать, ставит ли его ещё bb; следующая сверка проверит снова.",
  switchStillInstalling: () => "bb ещё ставит его из источника манифеста; следующая сверка проверит результат.",
  switchListUnknown: (p) =>
    `Установка из источника манифеста не завершилась (${p.error}), а список плагинов bb не прочитался; следующая сверка проверит снова.`,
  switchOtherSource: (p) => `Установка из источника манифеста не завершилась (${p.error}), а bb теперь показывает его из ${p.source}; оставлен как есть.`,
  switchRolledBack: (p) =>
    `Не удалось поставить из источника манифеста (${p.error}); прежний источник возвращён. Следующая попытка — ${p.next ? `после ${when(p.next, "ru")}` : "на следующей сверке"}.`,
  switchRollbackRunning: (p) =>
    `Не удалось поставить из источника манифеста (${p.error}); bb ещё возвращает прежний источник, следующая сверка проверит результат.`,
  switchWaiting: (p) =>
    `Оставлен на прежнем источнике: перейти на источник манифеста не удалось ${times(p.attempts)}; следующая попытка — после ${when(p.next, "ru")}.`,
  putBackWaiting: (p) =>
    `Возвращён на прежний источник: перейти на источник манифеста не удалось ${times(p.attempts)}; следующая попытка — после ${when(p.next, "ru")}.`,
  rollbackRunning: () => "bb ещё возвращает прежний источник; следующая сверка проверит результат.",
  abandonedListUnknown: () => "Больше не входит в сборку, а список плагинов bb не прочитался, чтобы завершить смену источника; следующая сверка проверит снова.",
  abandonedKept: (p) => `Больше не входит в сборку; незавершённая смена источника оставила его из ${p.source}, он оставлен.`,
  abandonedInstalling: () => "Больше не входит в сборку; bb ещё ставит его, следующая сверка проверит результат.",
  abandonedJobsUnknown: () => "Больше не входит в сборку; не удалось узнать, идёт ли ещё установка, следующая сверка проверит снова.",
  abandonedRollbackRunning: () => "Больше не входит в сборку; bb ещё возвращает прежний источник, следующая сверка проверит результат.",
  abandonedPutBack: () => "Больше не входит в сборку; возвращён прежний источник, который сняла незавершённая смена источника.",

  opencodeMissing: () => "OpenCode не установлен, поэтому его модели не настроены.",
  opencodeUnsupported: (p) => `OpenCode ${p.version} не поддерживается. Обновите OpenCode до 2.x.`,
  opencodeTooOld: (p) => `OpenCode ${p.version} слишком старый для этой сборки. Обновите OpenCode до 2.x.`,
  previousConfigCleaned: () => "Настройки Fleet Kit убраны из прежней конфигурации OpenCode.",
  previousConfigCleanFailed: (p) => `Не удалось очистить прежнюю конфигурацию: ${p.error}`,
  configUpdated: (p) => (p.backup ? `Обновлён; исходный файл сохранён как ${p.backup}.` : "Обновлён."),
  resolverUpdated: (p) => `Обновлён плагин OpenCode, который берёт ключи из хранилища «${storeName(p.store, "ru")}».`,
  modelPickerDirectory: (p) =>
    `Список моделей bb читает конфигурацию OpenCode по умолчанию, а не ${p.directory}. Запустите bb с OPENCODE_CONFIG_DIR=${p.directory}, чтобы в списке были модели сборки; треды эту папку уже используют.`,

  noticeReinstalled: (p) => `${p.plugin} переустановлен из нового источника. Введите его секретные настройки заново.`,
  noticePutBack: (p) => `${p.plugin} не перешёл на новый источник и возвращён на прежний. Введите его секретные настройки заново.`,
  noticeReinstalledDuringSwitch: (p) => `${p.plugin} переустановлен во время смены источника. Введите его секретные настройки заново.`,
  noticeAgentDisabled: (p) => `Агент ${p.agent} был включён, но сборка разрешает только ${p.allowed}; Fleet Kit снова его выключил.`,
};

/** Russian for texts that come from elsewhere: OpenCode's model checks (shared modules). */
const RAW_RU: Record<string, string> = {
  "Provider restrictions are off: every model available in OpenCode can be used.": "Ограничение провайдеров выключено: доступна любая модель OpenCode.",
  "The allowed provider setting is invalid.": "Список разрешённых провайдеров задан неверно.",
  "OpenCode's effective provider policy could not be verified.": "Не удалось проверить итоговую политику провайдеров OpenCode.",
  "OpenCode returned an unsupported effective policy statement.": "OpenCode вернул политику провайдеров в неизвестном виде.",
  "OpenCode must deny all providers before allowing the approved provider IDs.": "OpenCode должен сначала запрещать все провайдеры, а потом разрешать одобренные.",
  "OpenCode policy allows providers outside the approved list, or uses an unverifiable wildcard allow.":
    "Политика OpenCode разрешает провайдеры вне списка или разрешает их шаблоном, который нельзя проверить.",
  "OpenCode's available models could not be checked.": "Не удалось проверить, какие модели доступны в OpenCode.",
  "OpenCode returned no usable model list.": "OpenCode не вернул пригодный список моделей.",
  "OpenCode returned an unsupported model list format.": "OpenCode вернул список моделей в неизвестном формате.",
  "OpenCode has models outside the approved provider list.": "В OpenCode есть модели вне списка разрешённых провайдеров.",
  "Configuration check requires an absolute project directory.": "Для проверки конфигурации нужен абсолютный путь к проекту.",
  "Update OpenCode to 2.x: Fleet Kit configures OpenCode 2 only.": "Обновите OpenCode до 2.x: Fleet Kit настраивает только OpenCode 2.",
  "OpenCode configuration could not be checked.": "Не удалось проверить конфигурацию OpenCode.",
};

export const TEXTS: Record<Lang, Catalog> = { en, ru };

/** A text for the panel, with its English copy. */
export function say<C extends TextCode>(code: C, ...args: Parameters<Catalog[C]>): Said {
  const params = (args[0] ?? {}) as Params;
  return { code, params, message: (en[code] as (p: Params) => string)(params) };
}

/** Show a stored text in `lang`; unknown codes (from a newer server) fall back to the stored English. */
export function render(lang: Lang, text: { code?: string | undefined; params?: Params | undefined; message: string }): string {
  const fn = text.code !== undefined ? (TEXTS[lang] as unknown as Record<string, (p: Params) => string>)[text.code] : undefined;
  if (fn === undefined) return lang === "ru" && text.code === undefined ? ru.raw({ text: text.message }) : text.message;
  try {
    return fn(text.params ?? {});
  } catch {
    return text.message;
  }
}
