import { defineMessages, pluralRu } from "@/lib/i18n";

/** A detector category name for people; unknown ones show their own id. */
function label(key: string, names: Record<string, string>): string {
  return names[key] ?? (key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);
}

export const messages = defineMessages(
  {
    title: "Masking",
    on: "Masking on",
    off: "Masking off",
    unsupported: "Masking is not available for this agent",
    installing: "proxy is downloading, messages wait",
    starting: "proxy is starting",
    down: "proxy did not start, messages wait",
    downloadFailed: "proxy did not download, messages wait",
    notConfigured: "proxy is not installed, messages wait",
    noRequests: "no requests yet",
    counts: (requests: number, masked: number) =>
      `${requests} ${requests === 1 ? "request" : "requests"}, ${masked} masked`,
    turnOff: "Turn masking off for this thread",
    turnOn: "Turn masking on for this thread",
    proxyRunning: "Masking proxy is running.",
    proxyInstalling: "Masking proxy is downloading. Messages to the model wait in the queue and go out once it runs.",
    proxyStarting: "Masking proxy is starting.",
    proxyDown: (detail: string) =>
      `Masking proxy did not start (${detail}). The plugin keeps trying; messages to the model wait in the queue.`,
    proxyDownloadFailed: (detail: string) =>
      `Masking proxy did not download (${detail}). The plugin keeps trying; messages to the model wait in the queue.`,
    proxyNoSource: "Masking proxy is not installed: the plugin settings have no download URL. Messages to the model wait.",
    proxyNoFile: (path: string) => `Masking proxy is not installed: no file at ${path}. Messages to the model wait.`,
    offHint: "Requests from this thread go to the model provider unmasked.",
    empty: "No requests in this thread yet.",
    emptyHint:
      "Requests show up here as the agent works. A session that started before this plugin was installed goes direct: restart it.",
    viaProxy: "masked",
    viaDirect: "unmasked",
    viaBlocked: "not sent",
    maskedUnknown: "no report",
    maskedNone: "nothing to mask",
    countTokens: "token count",
    seconds: (value: string) => `${value} s`,
    category: (key: string) => label(key, {
      secrets: "secrets",
      assignments: "keys in code",
      structured_pii: "personal data",
      national_ids: "ID numbers",
      internal_hosts: "internal hosts",
      terms: "terms",
      addresses: "addresses",
      "ner:ORG": "organizations",
      "ner:PER": "names",
      "ner:LOC": "places",
    }),
  },
  {
    title: "Обфускация",
    on: "Обфускация включена",
    off: "Обфускация выключена",
    unsupported: "Обфускация для этого агента недоступна",
    installing: "прокси скачивается, сообщения ждут",
    starting: "прокси запускается",
    down: "прокси не запустился, сообщения ждут",
    downloadFailed: "прокси не скачался, сообщения ждут",
    notConfigured: "прокси не установлен, сообщения ждут",
    noRequests: "запросов пока не было",
    counts: (requests: number, masked: number) =>
      `${requests} ${pluralRu(requests, ["запрос", "запроса", "запросов"])}, скрыто ${masked}`,
    turnOff: "Выключить обфускацию в этом треде",
    turnOn: "Включить обфускацию в этом треде",
    proxyRunning: "Прокси обфускации работает.",
    proxyInstalling: "Прокси обфускации скачивается. Сообщения модели ждут в очереди и уйдут, когда он запустится.",
    proxyStarting: "Прокси обфускации запускается.",
    proxyDown: (detail: string) =>
      `Прокси обфускации не запустился (${detail}). Плагин пробует снова, сообщения модели ждут в очереди.`,
    proxyDownloadFailed: (detail: string) =>
      `Прокси обфускации не скачался (${detail}). Плагин пробует снова, сообщения модели ждут в очереди.`,
    proxyNoSource: "Прокси обфускации не установлен: в настройках плагина нет адреса загрузки. Сообщения модели ждут.",
    proxyNoFile: (path: string) => `Прокси обфускации не установлен: нет файла ${path}. Сообщения модели ждут.`,
    offHint: "Запросы этого треда уходят провайдеру модели без маскировки.",
    empty: "В этом треде запросов пока не было.",
    emptyHint:
      "Запросы появятся здесь, когда агент начнёт работать. Сессия, начатая до установки плагина, идёт напрямую: перезапустите её.",
    viaProxy: "замаскирован",
    viaDirect: "без маскировки",
    viaBlocked: "не отправлен",
    maskedUnknown: "нет отчёта",
    maskedNone: "нечего скрывать",
    countTokens: "подсчёт токенов",
    seconds: (value: string) => `${value} с`,
    category: (key: string) => label(key, {
      secrets: "секреты",
      assignments: "ключи в коде",
      structured_pii: "личные данные",
      national_ids: "номера документов",
      internal_hosts: "внутренние хосты",
      terms: "термины",
      addresses: "адреса",
      "ner:ORG": "организации",
      "ner:PER": "имена",
      "ner:LOC": "места",
    }),
  },
);
