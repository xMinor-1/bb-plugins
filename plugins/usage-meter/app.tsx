// bb-plugin-usage-meter — два кольца расхода лимитов Claude в футере сайдбара.
//
//   внешнее кольцо — пятичасовая сессия, окно "Current session"
//   внутреннее     — недельный лимит, окно "Weekly limit": радиус меньше,
//                    штрих тоньше, между кольцами видимый зазор
//   наведение      — попап со всеми окнами, планом и почтой аккаунта
//   клик           — тот же попап, но закреплённый (для тач-устройств)
//
// Каждое кольцо красится по своему значению: приглушённое до 60%, жёлтое с
// 60%, красное выше 85%. Лимит по модели (Fable) кольцом не рисуется — на
// кнопке 32×32 третье кольцо уже не читается, поэтому он живёт строкой в
// попапе, а на кнопке получает точку в правом верхнем углу, как только
// переваливает за жёлтый порог: иначе исчерпанное окно ничем себя не выдаёт.
//
// Разовый сбой опроса цифры не стирает: бэкенд держит прошлые окна, кольца
// продолжают их показывать, а попап отдельной строкой говорит возраст цифр и
// причину. Пустые кольца остаются только там, где снимка нет вовсе.
//
// sidebarFooterAction рисует хост, и рисует только иконку, поэтому кольца
// добавляет контент-скрипт: свой <svg> кладётся внутрь кнопки хоста поверх её
// иконки, а попап — обычным DOM поверх приложения. Иконка хоста остаётся на
// месте: свой узел лежит абсолютом и не ловит указатель.
//
// Внешнее кольцо повторяет геометрию соседнего плагина server-status: тот же
// путь по границе кнопки, та же толщина, та же анимация. В футере эти кнопки
// стоят рядом, и два индикатора обязаны читаться как одна система.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { UsageState, UsageWindow } from "./server";

const PLUGIN_ID = "usage-meter";
const ACTION_ID = "usage";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;

// Мост между `run` хоста и контент-скриптом: они живут в разных модулях одного
// окна, поэтому клавиатурная активация кнопки доезжает до попапа событием.
const TOGGLE_EVENT = "usage-meter:toggle";

/** Свой опрос снимка. Данные общие, так что чаще, чем бэкенд, смысла нет. */
const POLL_MS = 60_000;
/** Нижняя граница между опросами: защита от частых visibilitychange. */
const MIN_GAP_MS = 10_000;
/** Задержка перед попапом по наведению — курсор мимо кнопки его не открывает. */
const HOVER_MS = 250;
/** Фора на перевод курсора с кнопки в попап. */
const CLOSE_GRACE_MS = 250;

// --- геометрия колец --------------------------------------------------------

/** Толщина внешнего кольца. Ровно такая же у server-status — не менять в одиночку. */
const OUTER_STROKE = 2;
/** Внутреннее тоньше: пара должна читаться как «главное и уточняющее». */
const INNER_STROKE = 1.5;
/** Чистый зазор между штрихами колец, в пикселях кнопки. */
const RING_GAP = 2;
/**
 * Отступ центральной линии кольца от границы кнопки. Внешнее прижато к краю,
 * как у server-status; внутреннее отодвинуто на свою толщину плюс зазор,
 * поэтому на кнопке 32×32 его штрих идёт по 4…5.5 px от края и не достаёт до
 * иконки хоста (та занимает середину 16×16, то есть от 8 px).
 */
const OUTER_INSET = OUTER_STROKE / 2;
const INNER_INSET = OUTER_STROKE + RING_GAP + INNER_STROKE / 2;

// --- данные -----------------------------------------------------------------

async function fetchState(signal: AbortSignal): Promise<UsageState> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  const envelope = await response.json();
  if (!envelope?.ok) {
    throw new Error(envelope?.error?.message ?? "rpc failed");
  }
  return envelope.result as UsageState;
}

/** Подписи окон из API, по которым ищутся кольца. */
const SESSION_LABEL = "Current session";
const WEEKLY_LABEL = "Weekly limit";

/** Регистр и лишние пробелы в подписи окна нам не важны. */
function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/** Какое кольцо у этого окна; null — окно без кольца (лимит по модели). */
function ringOf(label: string): "outer" | "inner" | null {
  const key = labelKey(label);
  if (key === labelKey(SESSION_LABEL)) return "outer";
  if (key === labelKey(WEEKLY_LABEL)) return "inner";
  return null;
}

/**
 * Есть ли в снимке цифры, которым можно верить. При разовом сбое опроса бэкенд
 * оставляет прошлые окна (см. `toState` в server.ts) — они старые, но настоящие,
 * и честнее пустого кольца. Обнулённый снимок (`not_installed`,
 * `unauthenticated`, `expired`, `unknown`) приходит без окон.
 */
function hasFigures(state: UsageState | null): state is UsageState {
  if (!state || state.windows.length === 0) return false;
  return state.status === "ok" || state.status === "error";
}

/**
 * Окно по подписи. Набор окон задаёт API, и он имеет право отличаться:
 * ненайденное окно — не ошибка, просто кольцо для него не рисуется.
 */
function findWindow(
  state: UsageState | null,
  label: string,
): UsageWindow | null {
  if (!hasFigures(state)) return null;
  const wanted = labelKey(label);
  return state.windows.find((w) => labelKey(w.label) === wanted) ?? null;
}

/**
 * Наибольшее из окон, которым кольца не досталось (сейчас это лимит по модели).
 * По нему кнопка получает точку-метку: без неё исчерпанное окно молчит.
 */
function extraMax(state: UsageState | null): number | null {
  if (!hasFigures(state)) return null;
  let top: number | null = null;
  for (const limit of state.windows) {
    if (ringOf(limit.label) !== null) continue;
    const percent = percentOf(limit);
    if (percent !== null && (top === null || percent > top)) top = percent;
  }
  return top;
}

function percentOf(limit: UsageWindow | null): number | null {
  if (!limit || !Number.isFinite(limit.usedPercent)) return null;
  return Math.min(100, Math.max(0, limit.usedPercent));
}

/**
 * Пороги цвета. У соседнего server-status они свои (80% и 90%), и совпадать не
 * обязаны: там расход ОЗУ, где тревожно только под потолком, а здесь купленный
 * лимит, который на 60% уже стоит замечать. Чтобы одинаковая дуга у двух
 * соседних кнопок не читалась как одинаковая тревога, пороги названы в попапе.
 */
const WARN = 60;
const DANGER = 85;

/** Цвет кольца по его собственному значению; null — значения нет. */
function ringColor(percent: number | null): string {
  if (percent === null) return "var(--muted-foreground, #8a8a8a)";
  if (percent > DANGER) return "var(--destructive, #e5484d)";
  if (percent >= WARN) return "var(--warning, #e3a008)";
  return "var(--muted-foreground, #8a8a8a)";
}

// Английские подписи окон из API. Названия моделей ("Fable") остаются как есть.
const RU_LABEL: Record<string, string> = {
  [labelKey(SESSION_LABEL)]: "Сессия",
  [labelKey(WEEKLY_LABEL)]: "Неделя",
};

const TIME_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});
const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
});

/** Сегодняшняя ли дата — от неё зависит, нужна ли в подписи дата. */
function isToday(at: Date): boolean {
  const now = new Date();
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

/** Дату без точки на конце: Intl отдаёт «24 авг.», а нам нужна «24 авг». */
function dayText(at: Date): string {
  return DATE_FORMAT.format(at).replace(/\.$/, "");
}

/** «сброс в 17:20» для сегодняшнего сброса, «сброс 24 авг» для остальных. */
function resetText(iso: string | null): string {
  if (!iso) return "";
  const exact = new Date(iso);
  if (Number.isNaN(exact.getTime())) return "";
  // API отдаёт время с секундами (…14:19:59.781Z). Округляем до минуты, иначе
  // «сброс в 17:19» выглядит как ошибка на минуту.
  const at = new Date(Math.round(exact.getTime() / 60_000) * 60_000);
  return isToday(at)
    ? `сброс в ${TIME_FORMAT.format(at)}`
    : `сброс ${dayText(at)}`;
}

/** «Цифры на 16:48» — возраст прошлого удачного снимка. */
function ageText(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return isToday(at)
    ? `Цифры на ${TIME_FORMAT.format(at)}`
    : `Цифры от ${dayText(at)}, ${TIME_FORMAT.format(at)}`;
}

/**
 * Сообщения провайдера приходят по-английски («Claude usage is rate limited
 * right now.»), а интерфейс русский. Знакомые переводим, незнакомое в тело
 * строки не пускаем — оно уезжает в подсказку по наведению.
 */
const PROVIDER_REASONS: Array<[RegExp, string]> = [
  [
    /rate limit/i,
    "Claude ограничил частоту запросов, цифры обновятся позже",
  ],
  [/timed out|timeout|ETIMEDOUT/i, "Claude Code не ответил вовремя"],
  [
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i,
    "Нет связи с Claude",
  ],
];

/** Причина сбоя по-русски; null — сообщение незнакомое или его нет. */
function reasonText(message: string | null): string | null {
  if (!message) return null;
  for (const [pattern, text] of PROVIDER_REASONS) {
    if (pattern.test(message)) return text;
  }
  return null;
}

/** Строка попапа: что показать и что спрятать в подсказку. */
interface Line {
  text: string;
  /** Английский текст провайдера — только по наведению, не в интерфейсе. */
  title: string | null;
}

/** Почему цифр нет — человеческим языком. */
function statusLine(state: UsageState | null): Line {
  if (!state || state.status === "unknown") {
    return { text: "Загружаю лимиты…", title: null };
  }
  switch (state.status) {
    case "not_installed":
      return { text: "Claude Code не установлен", title: null };
    case "unauthenticated":
      return { text: "Claude Code не авторизован", title: null };
    case "expired":
      return { text: "Сессия Claude Code истекла, нужен повторный вход", title: null };
    case "error": {
      const reason = reasonText(state.message);
      return reason
        ? { text: `Не удалось получить лимиты: ${reason}`, title: null }
        : { text: "Не удалось получить лимиты", title: state.message };
    }
    default:
      return { text: "Лимиты не сообщаются", title: null };
  }
}

/** Возраст прошлых цифр и причина, по которой они не обновились. */
function staleLine(state: UsageState): Line {
  const reason = reasonText(state.message);
  const age = ageText(state.okAt);
  const failure = reason ? `обновить не удалось: ${reason}` : "обновить не удалось";
  return {
    text: age ? `${age} · ${failure}` : `${failure[0].toUpperCase()}${failure.slice(1)}`,
    title: reason ? null : state.message,
  };
}

// --- кольца -----------------------------------------------------------------

/**
 * Периметр скруглённого прямоугольника внутри кнопки; квадратная кнопка даст
 * круг. `inset` — расстояние от границы кнопки до центральной линии штриха.
 */
function ringPath(
  width: number,
  height: number,
  inset: number,
): { d: string; length: number } {
  const w = width - 2 * inset;
  const h = height - 2 * inset;
  const r = Math.min(w, h) / 2;
  const d = [
    // Старт сверху по центру, дальше по часовой стрелке — как у любого
    // кругового индикатора.
    `M${inset + w / 2} ${inset}`,
    `H${inset + w - r}`,
    `A${r} ${r} 0 0 1 ${inset + w} ${inset + r}`,
    `V${inset + h - r}`,
    `A${r} ${r} 0 0 1 ${inset + w - r} ${inset + h}`,
    `H${inset + r}`,
    `A${r} ${r} 0 0 1 ${inset} ${inset + h - r}`,
    `V${inset + r}`,
    `A${r} ${r} 0 0 1 ${inset + r} ${inset}`,
    "Z",
  ].join(" ");
  const length = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
  return { d, length };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Приглушённость незаполненной дорожки — общая с server-status. */
const TRACK_OPACITY = "0.22";

/** Одно кольцо: серая дорожка и заполненная дуга поверх неё. */
class Ring {
  /** Оба пути живут в своей группе, чтобы прятаться и появляться разом. */
  readonly group: SVGGElement;
  private readonly track: SVGPathElement;
  private readonly value: SVGPathElement;
  private length = 0;

  constructor(stroke: number, private readonly inset: number) {
    this.group = document.createElementNS(SVG_NS, "g");

    this.track = document.createElementNS(SVG_NS, "path");
    this.track.setAttribute("stroke", "var(--muted-foreground, #8a8a8a)");
    this.track.setAttribute("stroke-width", String(stroke));
    this.track.setAttribute("stroke-opacity", TRACK_OPACITY);

    this.value = document.createElementNS(SVG_NS, "path");
    this.value.setAttribute("stroke-width", String(stroke));
    this.value.setAttribute("stroke-linecap", "round");
    this.value.style.transition =
      "stroke-dasharray 300ms ease, stroke 300ms ease";

    this.group.append(this.track, this.value);
  }

  /** Пересчёт геометрии под текущий размер кнопки. */
  layout(width: number, height: number): void {
    const w = width - 2 * this.inset;
    const h = height - 2 * this.inset;
    // Сложенный сайдбар может дать кнопку уже внутреннего кольца — тогда его
    // просто нет, вместо вывернутого наизнанку пути.
    if (w <= 0 || h <= 0) {
      this.length = 0;
      this.group.style.display = "none";
      return;
    }
    this.group.style.display = "";
    const { d, length } = ringPath(width, height, this.inset);
    this.length = length;
    this.track.setAttribute("d", d);
    this.value.setAttribute("d", d);
  }

  /**
   * `percent` — значение своего окна, null — окна нет или снимок нерабочий.
   * `track` — показывать ли серую дорожку: у неизвестного снимка она стоит
   * пустым местом под будущие цифры, у чужого набора окон кольца нет вовсе.
   */
  draw(percent: number | null, track: boolean): void {
    this.track.setAttribute("stroke-opacity", track ? TRACK_OPACITY : "0");
    this.value.setAttribute("stroke", ringColor(percent));
    const filled = ((percent ?? 0) / 100) * this.length;
    this.value.setAttribute("stroke-dasharray", `${filled} ${this.length}`);
    // Нулевое значение рисовать нечем: круглый колпачок штриха оставил бы
    // точку на 12 часах, и пустое кольцо выглядело бы битым.
    this.value.setAttribute(
      "stroke-opacity",
      percent !== null && percent > 0 ? "1" : "0",
    );
  }
}

/** Радиус точки-метки для окна без кольца и её обводки цветом фона. */
const BADGE_RADIUS = 2.6;
const BADGE_HALO = 1.6;

/** Пара колец одним слоем поверх кнопки хоста. */
class Gauge {
  readonly node: HTMLSpanElement;
  private readonly svg: SVGSVGElement;
  private readonly outer = new Ring(OUTER_STROKE, OUTER_INSET);
  private readonly inner = new Ring(INNER_STROKE, INNER_INSET);
  /**
   * Метка окна, которому кольца не досталось. Сидит на внешнем кольце в правом
   * верхнем углу — там, где значки обычно и висят, — и отделена от кольца
   * обводкой цветом сайдбара.
   */
  private readonly badge: SVGCircleElement;
  /** Место для метки известно только после раскладки. */
  private badgeReady = false;

  constructor() {
    this.node = document.createElement("span");
    this.node.dataset.usageMeter = "rings";
    // Указатель кольца не ловят: клики и тултип остаются кнопке хоста.
    this.node.setAttribute(
      "style",
      "position:absolute;inset:0;pointer-events:none",
    );
    this.node.setAttribute("aria-hidden", "true");

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("fill", "none");
    this.svg.style.display = "block";
    this.svg.style.overflow = "visible";

    this.badge = document.createElementNS(SVG_NS, "circle");
    this.badge.setAttribute("r", String(BADGE_RADIUS));
    this.badge.setAttribute("stroke", "var(--sidebar, var(--background, #1b1b1b))");
    this.badge.setAttribute("stroke-width", String(BADGE_HALO));
    this.badge.style.display = "none";
    this.badge.style.transition = "fill 300ms ease";

    // Метка идёт последней: она поверх обоих колец.
    this.svg.append(this.outer.group, this.inner.group, this.badge);
    this.node.append(this.svg);
  }

  layout(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.outer.layout(width, height);
    this.inner.layout(width, height);
    // Точка на внешнем кольце под 45° вправо-вверх: у квадратной кнопки это
    // угол окружности, у вытянутой — верхняя правая скруглённая четверть.
    const w = width - 2 * OUTER_INSET;
    const h = height - 2 * OUTER_INSET;
    this.badgeReady = w > 2 * BADGE_RADIUS && h > 2 * BADGE_RADIUS;
    if (!this.badgeReady) {
      this.badge.style.display = "none";
      return;
    }
    const r = Math.min(w, h) / 2;
    const corner = r * Math.SQRT1_2;
    this.badge.setAttribute("cx", String(OUTER_INSET + w - r + corner));
    this.badge.setAttribute("cy", String(OUTER_INSET + r - corner));
  }

  /**
   * Значения окон сессии и недели плюс `extra` — максимум окон без кольца.
   * Пока снимка нет (`known` = false), оба кольца стоят серыми и пустыми, а
   * причина уезжает в попап.
   */
  draw(
    session: number | null,
    weekly: number | null,
    known: boolean,
    extra: number | null,
  ): void {
    this.outer.draw(session, session !== null || !known);
    this.inner.draw(weekly, weekly !== null || !known);
    // Метка зажигается ровно на том пороге, на котором желтеют кольца: до него
    // окно без кольца никого не беспокоит, после — молчать про него нельзя.
    const show = this.badgeReady && extra !== null && extra >= WARN;
    this.badge.style.display = show ? "" : "none";
    if (show) this.badge.setAttribute("fill", ringColor(extra));
  }
}

// --- попап ------------------------------------------------------------------

const PANEL_STYLE = [
  "position:fixed",
  "z-index:2147483000",
  "min-width:14rem",
  "max-width:20rem",
  "padding:0.5rem 0.625rem",
  "border:1px solid var(--border, rgba(128,128,128,0.3))",
  "border-radius:var(--radius, 0.5rem)",
  "background:var(--popover, var(--background, #1b1b1b))",
  "color:var(--popover-foreground, var(--foreground, #e5e5e5))",
  "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
  "font-size:0.8125rem",
  "font-family:inherit",
  "line-height:1.35",
].join(";");

const TITLE_STYLE = [
  "color:var(--muted-foreground, #9a9a9a)",
  "font-size:0.6875rem",
  "letter-spacing:0.04em",
  "text-transform:uppercase",
].join(";");

const MUTED_STYLE = "color:var(--muted-foreground, #9a9a9a)";

/**
 * Метка-кольцо в строке попапа. Пропорции кнопки в миниатюре не читаются —
 * у метки свои радиусы, лишь бы внешнее было толще и шире внутреннего, а
 * зазор между ними оставался видимым.
 */
const GLYPH_SIZE = 15;
const GLYPH_RINGS = [
  { key: "outer" as const, r: 6.4, stroke: 2 },
  { key: "inner" as const, r: 3.6, stroke: 1.3 },
];

function element(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Метка строки: та же пара колец в миниатюре, где своё кольцо выделено цветом,
 * а соседнее остаётся дорожкой. По ней видно, какая строка какое кольцо.
 */
function ringGlyph(which: "outer" | "inner", percent: number | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(GLYPH_SIZE));
  svg.setAttribute("height", String(GLYPH_SIZE));
  svg.setAttribute("viewBox", `0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const center = GLYPH_SIZE / 2;
  for (const { key, r, stroke } of GLYPH_RINGS) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(center));
    circle.setAttribute("cy", String(center));
    circle.setAttribute("r", String(r));
    circle.setAttribute("stroke-width", String(stroke));
    const own = key === which;
    circle.setAttribute(
      "stroke",
      own ? ringColor(percent) : "var(--muted-foreground, #8a8a8a)",
    );
    circle.setAttribute("stroke-opacity", own ? "1" : TRACK_OPACITY);
    svg.append(circle);
  }
  return svg;
}

/**
 * Метка строки окна без кольца: та же точка, что зажглась на кнопке. По ней
 * видно, какое именно окно её зажгло.
 */
function dotGlyph(percent: number | null): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(GLYPH_SIZE));
  svg.setAttribute("height", String(GLYPH_SIZE));
  svg.setAttribute("viewBox", `0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(GLYPH_SIZE / 2));
  dot.setAttribute("cy", String(GLYPH_SIZE / 2));
  dot.setAttribute("r", String(BADGE_RADIUS));
  dot.setAttribute("fill", ringColor(percent));
  svg.append(dot);
  return svg;
}

/** Тултипы хост открывает порталом прямо в body — вот их обёртка. */
const HOST_TOOLTIP = "[data-radix-popper-content-wrapper]";

/**
 * Верхний край тултипа хоста, который пересёкся бы с панелью в этом месте;
 * null — мешать некому.
 */
function tooltipOver(box: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): number | null {
  let ceiling: number | null = null;
  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>(HOST_TOOLTIP),
  )) {
    const tip = node.getBoundingClientRect();
    if (tip.width === 0 || tip.height === 0) continue;
    if (tip.right <= box.left || tip.left >= box.right) continue;
    if (tip.bottom <= box.top || tip.top >= box.bottom) continue;
    ceiling = ceiling === null ? tip.top : Math.min(ceiling, tip.top);
  }
  return ceiling;
}

/** Панель со всеми окнами лимитов, планом и почтой. */
class Popup {
  private panel: HTMLDivElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private closeTimer: number | null = null;
  /**
   * Потолок для нижнего края панели: тултип кнопки хоста висит над ней и шире
   * её, а попап стоит справа — углом они пересекаются. Разъехавшись один раз,
   * панель держится выше до самого закрытия: иначе она прыгала бы туда-сюда
   * вслед за тултипом.
   */
  private ceiling: number | null = null;
  private placeFrame = 0;
  /** Попап, открытый наведением, сам закрывается; закреплённый — нет. */
  pinned = false;

  get isOpen(): boolean {
    return this.panel !== null;
  }

  private cancelClose = (): void => {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  };

  private armClose = (): void => {
    if (this.pinned) return;
    this.cancelClose();
    this.closeTimer = window.setTimeout(this.close, CLOSE_GRACE_MS);
  };

  close = (): void => {
    this.cancelClose();
    if (this.placeFrame !== 0) {
      window.cancelAnimationFrame(this.placeFrame);
      this.placeFrame = 0;
    }
    for (const off of this.cleanup.splice(0)) off();
    this.panel?.remove();
    this.panel = null;
    this.anchor = null;
    this.ceiling = null;
    this.pinned = false;
  };

  open(anchor: HTMLElement, state: UsageState | null, pinned: boolean): void {
    if (this.panel && this.anchor === anchor) {
      this.pinned = this.pinned || pinned;
      if (this.pinned) this.cancelClose();
      this.render(state);
      return;
    }
    this.close();
    this.pinned = pinned;
    this.anchor = anchor;

    const panel = document.createElement("div");
    panel.setAttribute("style", PANEL_STYLE);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Расход лимитов");
    panel.dataset.usageMeter = "popup";
    // Прячем за экраном, пока не известна высота.
    panel.style.left = "-9999px";
    panel.style.top = "0";
    document.body.append(panel);
    this.panel = panel;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Клик по самой кнопке разбирает её собственный обработчик.
      if (panel.contains(target) || anchor.contains(target)) return;
      this.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", this.close);
    panel.addEventListener("pointerenter", this.cancelClose);
    panel.addEventListener("pointerleave", this.armClose);
    // Тултип кнопки появляется со своей задержкой, уже после попапа, и портал
    // кладёт его прямо в body. Ждём его, чтобы уступить место.
    const portals = new MutationObserver(() => {
      if (this.placeFrame !== 0) return;
      this.placeFrame = window.requestAnimationFrame(() => {
        this.placeFrame = 0;
        this.place();
      });
    });
    portals.observe(document.body, { childList: true });
    this.cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("resize", this.close),
      () => portals.disconnect(),
    );

    this.render(state);
  }

  /** Перерисовка по свежему снимку — попап может быть открыт во время опроса. */
  render(state: UsageState | null): void {
    const panel = this.panel;
    if (!panel) return;
    panel.replaceChildren();

    panel.append(element("div", TITLE_STYLE, "Расход лимитов"));

    // Цифры показываем и после сбоя: они старые, но настоящие. Пустая панель
    // остаётся только там, где показывать нечего.
    const figures = hasFigures(state);
    if (!state || (state.status !== "ok" && !figures)) {
      panel.append(this.note(statusLine(state), "margin-top:0.375rem"));
      this.place();
      return;
    }

    if (state.planLabel) {
      panel.append(
        element("div", "margin-top:0.25rem;font-weight:500", state.planLabel),
      );
    }
    if (state.accountEmail) {
      panel.append(
        element("div", `${MUTED_STYLE};font-size:0.75rem`, state.accountEmail),
      );
    }

    const rows = element(
      "div",
      "margin-top:0.5rem;display:flex;flex-direction:column;gap:0.25rem",
    );
    let rings = false;
    for (const limit of state.windows) {
      const key = labelKey(limit.label);
      const row = element(
        "div",
        "display:flex;gap:0.375rem;align-items:center;min-width:0",
      );
      // Окна, у которых есть кольцо, помечены им же; окно без кольца — той же
      // точкой, что зажглась на кнопке; остальные — отступом той же ширины,
      // чтобы проценты стояли одной колонкой.
      const percent = percentOf(limit);
      const ring = ringOf(limit.label);
      if (ring) {
        rings = true;
        row.append(ringGlyph(ring, percent));
      } else if (percent !== null && percent >= WARN) {
        row.append(dotGlyph(percent));
      } else {
        row.append(element("span", `width:${GLYPH_SIZE}px;flex:none`));
      }

      // Подпись окна задаёт API, и длинная («Claude Opus 4.6 extended thinking
      // window») обязана обрезаться внутри панели, а не вылезать наружу.
      const label = element(
        "span",
        "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
        RU_LABEL[key] ?? limit.label,
      );
      if (!RU_LABEL[key]) label.title = limit.label;
      row.append(label);
      row.append(
        element(
          "span",
          "flex:none;white-space:nowrap",
          `${Math.round(limit.usedPercent)}%`,
        ),
      );
      const reset = resetText(limit.resetsAt);
      if (reset) {
        row.append(
          element(
            "span",
            `${MUTED_STYLE};font-size:0.75rem;flex:none;white-space:nowrap`,
            `· ${reset}`,
          ),
        );
      }
      rows.append(row);
    }
    if (state.windows.length === 0) {
      rows.append(element("div", MUTED_STYLE, "Окон лимитов нет"));
    }
    panel.append(rows);

    // Цифры прошлые: без этой строки кольца выдавали бы старое за свежее.
    if (state.status !== "ok") {
      panel.append(this.note(staleLine(state), "margin-top:0.375rem"));
    }
    // Пороги названы словами: у соседней кнопки в футере они другие, и по
    // одному цвету догадаться, с какого процента он загорается, нельзя.
    if (rings) {
      panel.append(
        this.note(
          {
            text: `Кольца желтеют с ${WARN}%, краснеют выше ${DANGER}%`,
            title: null,
          },
          "margin-top:0.375rem;font-size:0.6875rem",
        ),
      );
    }
    this.place();
  }

  /** Приглушённая строка снизу панели; незнакомый текст уходит в подсказку. */
  private note(line: Line, extra: string): HTMLElement {
    const node = element("div", `${MUTED_STYLE};${extra}`, line.text);
    if (line.title) node.title = line.title;
    return node;
  }

  /** Справа от кнопки, нижним краем по кнопке; в экран вписывается всегда. */
  private place(): void {
    const panel = this.panel;
    const anchor = this.anchor;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.right + 8),
      Math.max(8, window.innerWidth - size.width - 8),
    );
    let top = Math.min(
      Math.max(8, rect.bottom - size.height),
      Math.max(8, window.innerHeight - size.height - 8),
    );
    const tip = tooltipOver({
      left,
      top,
      right: left + size.width,
      bottom: top + size.height,
    });
    if (tip !== null) this.ceiling = Math.min(this.ceiling ?? tip, tip);
    // Панель поднимается над тултипом. Если выше места нет, прижимаемся к
    // верху экрана: перекрытие лучше панели, уехавшей за край.
    if (this.ceiling !== null) {
      top = Math.max(8, Math.min(top, this.ceiling - size.height - 8));
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** Курсор ушёл с кнопки: попап по наведению закрывается, закреплённый живёт. */
  leave(): void {
    this.armClose();
  }

  enter(): void {
    this.cancelClose();
  }
}

// --- регистрация ------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Расход лимитов",
    icon: "ChartColumn",
    // Мышь и тач кнопку перехватывает контент-скрипт, но клавиатурная
    // активация доходит сюда — событие открывает тот же попап.
    run: () => {
      document.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });

  app.contentScripts.register({
    id: "usage-rings",
    mount({ signal }) {
      const gauge = new Gauge();
      const popup = new Popup();
      let state: UsageState | null = null;
      let button: HTMLElement | null = null;
      // Инлайновый position кнопки до нас: кольцам нужен контекст
      // позиционирования, и на снятии значение возвращается как было.
      let restorePosition: string | null = null;
      let hoverTimer: number | null = null;
      let suppressClick = false;
      let lastFetch = 0;
      let inFlight = false;

      const draw = () => {
        // Снимок «известен», пока в нём есть цифры — свежие или прошлые. Пустые
        // дорожки под будущие цифры остаются только для обнулённого снимка.
        const known = state?.status === "ok" || hasFigures(state);
        gauge.draw(
          percentOf(findWindow(state, SESSION_LABEL)),
          percentOf(findWindow(state, WEEKLY_LABEL)),
          known,
          extraMax(state),
        );
      };

      // Размер кнопки задаёт геометрию колец: сайдбар умеет складываться.
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.contentRect;
          const target = entry.target as HTMLElement;
          gauge.layout(
            target.offsetWidth || box.width,
            target.offsetHeight || box.height,
          );
        }
        draw();
      });

      const detach = () => {
        resizeObserver.disconnect();
        gauge.node.remove();
        if (button && restorePosition !== null) {
          button.style.position = restorePosition;
        }
        restorePosition = null;
        button = null;
      };

      const attach = (next: HTMLElement) => {
        if (button === next && gauge.node.parentNode === next) return;
        if (button !== next) detach();
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        // Свой свежесозданный узел в контейнер хоста класть можно — чужие
        // узлы не двигаются и не удаляются.
        next.append(gauge.node);
        gauge.layout(next.offsetWidth, next.offsetHeight);
        draw();
        resizeObserver.observe(next);
      };

      // Кнопку рисует хост, и к моменту старта скрипта её может не быть —
      // ждём появления, а заодно возвращаем кольца, если React перерисовал
      // футер и унёс наш узел вместе со старой кнопкой.
      let scheduled = 0;
      const sync = () => {
        scheduled = 0;
        const found = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        if (!found) {
          if (button) {
            popup.close();
            detach();
          }
          return;
        }
        attach(found);
      };
      const schedule = () => {
        if (scheduled !== 0) return;
        scheduled = window.requestAnimationFrame(sync);
      };
      const domObserver = new MutationObserver(() => {
        // Дешёвая проверка на каждую мутацию документа: пока кнопка та же и
        // кольца на месте, ничего не делаем.
        if (button?.isConnected && gauge.node.parentNode === button) return;
        schedule();
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      sync();

      const refresh = async (force = false): Promise<void> => {
        // Скрытая вкладка из опроса ничего не узнаёт, а каждая открытая иначе
        // продолжала бы дёргать тот же сервер.
        if (document.visibilityState === "hidden" || inFlight || signal.aborted) {
          return;
        }
        const now = Date.now();
        if (!force && now - lastFetch < MIN_GAP_MS) return;
        lastFetch = now;
        inFlight = true;
        try {
          state = await fetchState(signal);
        } catch {
          // Сеть моргнула или сервер перезагружается: показываем прошлый
          // снимок и ждём следующего опроса, в консоль не шумим.
          return;
        } finally {
          inFlight = false;
        }
        draw();
        popup.render(state);
      };

      void refresh(true);
      const timer = window.setInterval(() => void refresh(true), POLL_MS);

      // Вкладку вернули из фона — цифры там уже могли протухнуть.
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.visibilityState === "visible") void refresh();
        },
        { signal },
      );

      const buttonFrom = (target: EventTarget | null): HTMLElement | null =>
        target instanceof Element
          ? (target.closest(BUTTON_SELECTOR) as HTMLElement | null)
          : null;

      const cancelHover = () => {
        if (hoverTimer !== null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
      };

      const toggle = () => {
        const anchor = button;
        if (!anchor) return;
        if (popup.isOpen && popup.pinned) {
          popup.close();
          return;
        }
        void refresh();
        popup.open(anchor, state, true);
      };

      // Нажатие мышью или пальцем: закрепляем попап сами и гасим клик, иначе
      // хост вызовет `run` и попап закроется тут же следом.
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0 || !buttonFrom(event.target)) return;
          cancelHover();
          suppressClick = true;
          toggle();
        },
        { capture: true, signal },
      );

      document.addEventListener(
        "click",
        (event) => {
          if (!suppressClick || !buttonFrom(event.target)) return;
          suppressClick = false;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true, signal },
      );

      // Клавиатурная активация приходит из `run` слота.
      document.addEventListener(TOGGLE_EVENT, () => toggle(), { signal });

      // Наведение открывает тот же попап без нажатия. Только мышь: у тача
      // «наведение» — это начало тапа, а тап уже разобран выше.
      document.addEventListener(
        "pointerover",
        (event) => {
          if (event.pointerType !== "mouse") return;
          const over = buttonFrom(event.target);
          if (!over) return;
          popup.enter();
          if (popup.isOpen || hoverTimer !== null) return;
          hoverTimer = window.setTimeout(() => {
            hoverTimer = null;
            if (!button) return;
            void refresh();
            popup.open(button, state, false);
          }, HOVER_MS);
        },
        { capture: true, signal },
      );

      document.addEventListener(
        "pointerout",
        (event) => {
          const out = buttonFrom(event.target);
          if (!out) return;
          // Переход между потрохами самой кнопки — не уход.
          const to = event.relatedTarget;
          if (to instanceof Node && out.contains(to)) return;
          cancelHover();
          popup.leave();
        },
        { capture: true, signal },
      );

      return () => {
        cancelHover();
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
        window.clearInterval(timer);
        domObserver.disconnect();
        popup.close();
        detach();
      };
    },
  });
});
