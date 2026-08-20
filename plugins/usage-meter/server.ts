// bb-plugin-usage-meter — бэкенд: один опрос лимитов Claude на весь сервер.
//
// Фоновый сервис раз в пять минут спрашивает bb.sdk.system.usageLimits() и
// держит снимок в памяти. Все клиенты читают этот же снимок RPC-методом
// `state`, поэтому число вкладок не увеличивает нагрузку на API.
//
// Realtime тут не при делах: кольца рисует контент-скрипт, а подписка на канал
// живёт только в React-хуке useRealtime, до которого контент-скрипту не
// дотянуться. Публиковать снимок было бы некому — фронт опрашивает `state`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Провайдер сам ограничивает частоту вызова: минутный опрос он через час
// работы отбивал ответом «Claude usage is rate limited right now». Лимиты
// меняются медленно, пяти минут хватает с запасом.
/** Период опроса лимитов. */
const POLL_MS = 5 * 60_000;
/** Потолок отката: после неудачи период удваивается, но не дальше получаса. */
const RETRY_MAX_MS = 30 * 60_000;

// Тип ответа SDK (ProviderUsageResponse) сам пакет наружу не отдаёт, но его
// можно вывести из сигнатуры метода — это честная типизация вместо any.
type UsageLimits = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>
>;
type ClaudeUsage = UsageLimits["claudeCode"];

const usageWindow = z.object({
  /** Английская подпись окна из API: "Current session", "Weekly limit", "Fable". */
  label: z.string(),
  usedPercent: z.number(),
  /** ISO-время сброса; API имеет право не знать его. */
  resetsAt: z.string().nullable(),
});

const usageState = z.object({
  /** Статусы провайдера из SDK плюс "unknown" — снимка ещё нет. */
  status: z.enum([
    "ok",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
    "unknown",
  ]),
  planLabel: z.string().nullable(),
  accountEmail: z.string().nullable(),
  windows: z.array(usageWindow),
  /** Текст ошибки от провайдера или от самого вызова, если он не прошёл. */
  message: z.string().nullable(),
  /** Когда снимок снят, ISO. null — ни одного успешного вызова ещё не было. */
  fetchedAt: z.string().nullable(),
  /**
   * Когда цифры в `windows` были свежими, ISO. При разовом сбое цифры
   * остаются на экране, а по этому времени видно их возраст.
   */
  okAt: z.string().nullable(),
});

/** Снимок, который видит фронт. app.tsx импортирует только эти типы. */
export type UsageState = z.infer<typeof usageState>;
export type UsageWindow = z.infer<typeof usageWindow>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: usageState },
});

/** Пустой снимок до первого удачного опроса. */
const UNKNOWN: UsageState = {
  status: "unknown",
  planLabel: null,
  accountEmail: null,
  windows: [],
  message: null,
  fetchedAt: null,
  okAt: null,
};

/** Ответ провайдера → снимок. Разбор строго по discriminated union из SDK. */
function toState(claude: ClaudeUsage, previous: UsageState): UsageState {
  const fetchedAt = new Date().toISOString();
  if (claude.status === "ok") {
    return {
      status: "ok",
      planLabel: claude.planLabel,
      accountEmail: claude.accountEmail,
      windows: claude.windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      })),
      message: null,
      fetchedAt,
      okAt: fetchedAt,
    };
  }
  if (claude.status === "error") {
    // Сбой разовый: сеть, тайм-аут, ограничение частоты у провайдера. Прошлые
    // цифры честнее пустого кольца — оставляем их вместе с их возрастом.
    return {
      status: "error",
      planLabel: claude.planLabel ?? previous.planLabel,
      accountEmail: claude.accountEmail ?? previous.accountEmail,
      windows: previous.windows,
      message: claude.message,
      fetchedAt,
      okAt: previous.okAt,
    };
  }
  // not_installed / unauthenticated / expired — API не сообщает ни плана, ни
  // почты, и старые цифры больше не про этот аккаунт: снимок обнуляется.
  return { ...UNKNOWN, status: claude.status, fetchedAt };
}

export default async function plugin(bb: BbPluginApi) {
  let current: UsageState = UNKNOWN;
  // Ключ последней жалобы в лог: одна и та же беда пишется один раз, иначе
  // недоступный провайдер засыпал бы лог каждую минуту.
  let complaint = "";
  // Один вызов на всех: параллельные `state` до первого опроса ждут его, а не
  // дёргают API повторно.
  let inFlight: Promise<UsageState> | null = null;

  async function refresh(signal?: AbortSignal): Promise<UsageState> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const usage = await bb.sdk.system.usageLimits(
          signal ? { signal } : undefined,
        );
        const next = toState(usage.claudeCode, current);
        const key = next.status === "ok" ? "" : `${next.status}:${next.message ?? ""}`;
        if (key !== complaint) {
          complaint = key;
          if (key) bb.log.info(`claude code: ${next.status}${next.message ? ` — ${next.message}` : ""}`);
        }
        current = next;
        return current;
      } catch (error) {
        // Отмена по перезагрузке или остановке — не беда, о ней не пишут.
        if (signal?.aborted) return current;
        // Сам вызов не прошёл. Держим прошлый снимок, помечаем ошибку и
        // жалуемся не чаще одного раза на одну и ту же причину.
        const message = error instanceof Error ? error.message : String(error);
        if (message !== complaint) {
          complaint = message;
          bb.log.warn(`usageLimits failed: ${message}`);
        }
        // fetchedAt проставляем и тут: иначе каждый клиент, увидев снимок без
        // времени, звал бы refresh сам.
        current = {
          ...current,
          status: "error",
          message,
          fetchedAt: new Date().toISOString(),
        };
        return current;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  bb.rpc.register(rpcContract, {
    // Отдаём снимок из памяти. Первый клиент, пришедший раньше сервиса,
    // получает результат общего опроса, а не собственный вызов API.
    state: async () => (current.fetchedAt === null ? refresh() : current),
  });

  bb.background.service("poll", {
    async start(signal) {
      let delay = POLL_MS;
      while (!signal.aborted) {
        const next = await refresh(signal);
        // Отбились по частоте или сеть легла — отходим подальше, чтобы не
        // добивать провайдера; удачный опрос возвращает обычный шаг.
        delay = next.status === "ok" ? POLL_MS : Math.min(delay * 2, RETRY_MAX_MS);
        // Сон обязан просыпаться на abort, иначе перезагрузка плагина ждёт
        // минуту и получает "degraded (service did not stop)".
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}
