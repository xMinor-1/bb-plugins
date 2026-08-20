// bb-plugin-server-status — состояние сервера в футере сайдбара.
//
//   иконка   — кнопка хоста рядом с шестерёнкой, палитрой и жуком
//   кольцо   — расход оперативной памяти: приглушённое, жёлтое с 80%,
//              красное выше 90%
//   клик     — окно с полной сводкой: процессор, память, подкачка, диск,
//              средняя нагрузка, аптайм, ядро и ОС
//
// sidebarFooterAction рисует хост, и рисует только иконку, поэтому кольцо
// добавляет контент-скрипт: свой <svg> кладётся внутрь кнопки хоста поверх её
// иконки, а окно — обычным DOM поверх приложения. Чужие узлы не двигаются и не
// удаляются, своё снимается disposer'ом.
//
// Геометрия кольца, толщина, скругление и анимация повторяют плагин
// usage-meter: в футере два кольца рядом, и они обязаны читаться как одна
// система. Отличается только логика цветов — пороги здесь по ТЗ владельца.
//
// Хуков React в контент-скрипте нет, значит useRealtime недоступен: скрипт
// опрашивает rpc `state` тем же тиком в 5 секунд, каким снимает метрики
// бэкенд, и молчит, пока вкладка скрыта.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { Snapshot } from "./server";

const PLUGIN_ID = "server-status";
const ACTION_ID = "status";
const BUTTON_SELECTOR = `[data-testid="plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}"]`;

// Мост между `run` хоста и контент-скриптом: они живут в разных модулях одного
// окна, поэтому клавиатурная активация кнопки доезжает до окна событием.
const TOGGLE_EVENT = "server-status:toggle";

/** Тик опроса — тот же, с каким снимает метрики бэкенд. */
const POLL_MS = 5_000;
/** Нижняя граница между опросами: защита от частых visibilitychange. */
const MIN_GAP_MS = 2_000;

/** Толщина кольца — как у usage-meter, иначе два кольца рядом разъедутся. */
const RING_STROKE = 2;

/** Пороги цвета для оперативной памяти (и для полос в окне). */
const WARN = 80;
const DANGER = 90;

// Подкачка ниже этого почти не тронута — постоянная плашка была бы шумом.
// Выше — память уже не помещается в ОЗУ, и об этом стоит сказать словами.
const SWAP_NOTE = 10;

const STYLE_ID = "bb-server-status-style";

// --- данные -----------------------------------------------------------------

async function fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
    signal,
  });
  const envelope = (await response.json()) as
    | { ok: true; result: Snapshot }
    | { ok: false; error?: { message?: string } };
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "rpc failed");
  return envelope.result;
}

// --- цвета и уровни ---------------------------------------------------------

type Level = "ok" | "warn" | "danger";

function level(percent: number | null): Level {
  if (percent === null) return "ok";
  if (percent > DANGER) return "danger";
  if (percent >= WARN) return "warn";
  return "ok";
}

function levelColor(value: Level): string {
  if (value === "danger") return "var(--destructive, #e5484d)";
  if (value === "warn") return "var(--warning, #e3a008)";
  return "var(--muted-foreground, #8a8a8a)";
}

// --- форматирование ---------------------------------------------------------

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

const NUM1 = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Единица подписывается один раз на всю строку, поэтому её выбирает наибольшее
 * из чисел строки, а печатаются они все в ней: у тома на девять терабайт
 * «занято 9220 из 9313 ГБ» не читается — нужно «занято 9,0 из 9,1 ТБ».
 */
function scale(...bytes: number[]): { unit: string; format: (value: number) => string } {
  const tera = Math.max(...bytes) >= TIB;
  const divisor = tera ? TIB : GIB;
  return {
    unit: tera ? "ТБ" : "ГБ",
    // От сотни дробная часть — уже шум: «104», а не «104,3».
    format: (value: number): string => {
      const scaled = value / divisor;
      return scaled >= 100 ? String(Math.round(scaled)) : NUM1.format(scaled);
    },
  };
}

function percentText(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

/** Русские окончания: 1 день, 2 дня, 5 дней. */
function plural(count: number, one: string, few: string, many: string): string {
  const tail100 = count % 100;
  const tail10 = count % 10;
  if (tail100 >= 11 && tail100 <= 14) return many;
  if (tail10 === 1) return one;
  if (tail10 >= 2 && tail10 <= 4) return few;
  return many;
}

function uptimeRu(seconds: number): string {
  // «0 минут» выглядит как сбой ровно тогда, когда на аптайм и смотрят, —
  // в первую минуту после перезагрузки.
  if (seconds < 60) return "меньше минуты";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${days} ${plural(days, "день", "дня", "дней")} ${hours} ${plural(hours, "час", "часа", "часов")}`;
  }
  if (hours > 0) {
    return `${hours} ${plural(hours, "час", "часа", "часов")} ${minutes} ${plural(minutes, "минута", "минуты", "минут")}`;
  }
  return `${minutes} ${plural(minutes, "минута", "минуты", "минут")}`;
}

const BOOT_DATE = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const BOOT_TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});

/** «1 августа 2026, 17:03» — без канцелярского «г. в» посреди строки. */
function bootedRu(ms: number): string {
  const at = new Date(ms);
  const date = BOOT_DATE.format(at).replace(/\s*г\.$/, "");
  return `${date}, ${BOOT_TIME.format(at)}`;
}

// Аптайм растёт от момента загрузки, который сервер сообщил один раз, поэтому
// открытая вкладка считает сама и не переспрашивает.
function uptimeSeconds(snapshot: Snapshot): number {
  const grown = Math.round((Date.now() - snapshot.bootTimeMs) / 1000);
  return Number.isFinite(grown) && grown > 0 ? grown : snapshot.uptimeSeconds;
}

// --- кольцо -----------------------------------------------------------------

/** Периметр скруглённого прямоугольника по границе кнопки; квадрат даст круг. */
function ringPath(width: number, height: number): { d: string; length: number } {
  const inset = RING_STROKE / 2;
  const w = Math.max(0, width - RING_STROKE);
  const h = Math.max(0, height - RING_STROKE);
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

/** Свой узел поверх кнопки хоста: дорожка и заполненная дуга. */
class Ring {
  readonly node: HTMLSpanElement;
  private readonly svg: SVGSVGElement;
  private readonly track: SVGPathElement;
  private readonly value: SVGPathElement;
  private length = 0;

  constructor() {
    this.node = document.createElement("span");
    this.node.dataset.serverStatus = "ring";
    // Указатель кольцо не ловит: клики и тултип остаются кнопке хоста.
    this.node.setAttribute("style", "position:absolute;inset:0;pointer-events:none");
    this.node.setAttribute("aria-hidden", "true");

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("fill", "none");
    this.svg.style.display = "block";
    this.svg.style.overflow = "visible";

    this.track = document.createElementNS(SVG_NS, "path");
    this.track.setAttribute("stroke", "var(--muted-foreground, #8a8a8a)");
    this.track.setAttribute("stroke-width", String(RING_STROKE));
    this.track.setAttribute("stroke-opacity", "0.22");

    this.value = document.createElementNS(SVG_NS, "path");
    this.value.setAttribute("stroke-width", String(RING_STROKE));
    this.value.setAttribute("stroke-linecap", "round");
    this.value.style.transition = "stroke-dasharray 300ms ease, stroke 300ms ease";

    this.svg.append(this.track, this.value);
    this.node.append(this.svg);
  }

  /** Пересчёт геометрии под текущий размер кнопки. */
  layout(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const { d, length } = ringPath(width, height);
    this.length = length;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.track.setAttribute("d", d);
    this.value.setAttribute("d", d);
  }

  /** Кольцо показывает расход ОЗУ; null — снимка ещё нет, только дорожка. */
  draw(percent: number | null): void {
    const known = percent !== null;
    const safe = known ? Math.min(100, Math.max(0, percent)) : 0;
    const filled = (safe / 100) * this.length;
    this.value.setAttribute("stroke", levelColor(level(percent)));
    this.value.setAttribute("stroke-dasharray", `${filled} ${this.length}`);
    this.value.setAttribute("stroke-opacity", known && safe > 0 ? "1" : "0");
  }
}

// --- окно -------------------------------------------------------------------

// Окно живёт в document.body поверх приложения, поэтому стили держим в своём
// листе и снимаем его вместе со всем остальным на dispose.
const CSS = `
[data-server-status="panel"] {
  position: fixed;
  z-index: 2147483000;
  /* Хватает, чтобы «Последняя перезагрузка: 1 августа 2026, 17:03» легла в
     одну строку — окно читается, а не разгадывается. */
  width: 21rem;
  max-width: calc(100vw - 1rem);
  max-height: calc(100vh - 1rem);
  overflow-y: auto;
  padding: 0.75rem 0.875rem 0.8125rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  border-radius: var(--radius, 0.5rem);
  background: var(--popover, var(--background, #1b1b1b));
  color: var(--popover-foreground, var(--foreground, #e5e5e5));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.bb-ss-title {
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.6875rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.bb-ss-host {
  margin-top: 0.125rem;
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-metric { margin-top: 0.6875rem; }
.bb-ss-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.bb-ss-name { font-weight: 500; }
.bb-ss-mount {
  margin-left: 0.25rem;
  color: var(--muted-foreground, #9a9a9a);
  font-weight: 400;
  font-size: 0.75rem;
}
.bb-ss-value[data-level="warn"] { color: var(--warning, #e3a008); }
.bb-ss-value[data-level="danger"] { color: var(--destructive, #e5484d); }
.bb-ss-bar {
  position: relative;
  height: 3px;
  margin-top: 0.3125rem;
  border-radius: 999px;
}
.bb-ss-track {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--muted-foreground, #8a8a8a);
  opacity: 0.22;
}
.bb-ss-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
  background: var(--muted-foreground, #8a8a8a);
  /* Та же длительность, что у кольца: две шкалы двигаются в такт. */
  transition: width 300ms ease, background-color 300ms ease;
}
.bb-ss-fill[data-level="warn"] { background: var(--warning, #e3a008); }
.bb-ss-fill[data-level="danger"] { background: var(--destructive, #e5484d); }
.bb-ss-detail {
  margin-top: 0.25rem;
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-note {
  margin-top: 0.3125rem;
  padding: 0.3125rem 0.4375rem;
  border-radius: calc(var(--radius, 0.5rem) - 0.25rem);
  background: color-mix(in srgb, var(--warning, #e3a008) 14%, transparent);
  color: var(--warning, #e3a008);
  font-size: 0.75rem;
}
.bb-ss-foot {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.3));
  color: var(--muted-foreground, #9a9a9a);
  font-size: 0.75rem;
}
.bb-ss-foot div + div { margin-top: 0.125rem; }
.bb-ss-stale {
  margin-top: 0.375rem;
  color: var(--destructive, #e5484d);
  font-size: 0.75rem;
}
[data-server-status="panel"] [hidden] { display: none; }
`;

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Одна метрика окна: название, процент, полоса и строка подробностей. */
class MetricRow {
  readonly root: HTMLDivElement;
  private readonly mount: HTMLSpanElement;
  private readonly value: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly detail: HTMLDivElement;

  constructor(name: string) {
    this.root = div("bb-ss-metric");
    const head = div("bb-ss-head");
    const title = document.createElement("span");
    title.className = "bb-ss-name";
    title.textContent = name;
    this.mount = document.createElement("span");
    this.mount.className = "bb-ss-mount";
    title.append(this.mount);
    this.value = document.createElement("span");
    this.value.className = "bb-ss-value";
    head.append(title, this.value);

    const bar = div("bb-ss-bar");
    this.fill = div("bb-ss-fill");
    this.fill.style.width = "0%";
    bar.append(div("bb-ss-track"), this.fill);

    this.detail = div("bb-ss-detail");
    this.root.append(head, bar, this.detail);
  }

  update(percent: number | null, detail: string, mount = ""): void {
    const state = level(percent);
    this.value.textContent = percentText(percent);
    this.value.dataset.level = state;
    this.fill.style.width = `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%`;
    this.fill.dataset.level = state;
    this.detail.textContent = detail;
    this.mount.textContent = mount;
  }

  set hidden(value: boolean) {
    this.root.hidden = value;
  }
}

/**
 * Окно с полной сводкой. Структура строится один раз, дальше меняются только
 * значения — так полосы успевают доехать анимацией, а не прыгают.
 */
class Panel {
  private node: HTMLDivElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: Array<() => void> = [];
  private host!: HTMLDivElement;
  private cpu!: MetricRow;
  private memory!: MetricRow;
  private swap!: MetricRow;
  private disk!: MetricRow;
  private swapNote!: HTMLDivElement;
  private loadAvg!: HTMLDivElement;
  private uptime!: HTMLDivElement;
  private booted!: HTMLDivElement;
  private stale!: HTMLDivElement;

  constructor(private readonly onClose: () => void) {}

  get isOpen(): boolean {
    return this.node !== null;
  }

  private build(): HTMLDivElement {
    const node = div("");
    node.dataset.serverStatus = "panel";
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "Состояние сервера");
    node.tabIndex = -1;

    this.host = div("bb-ss-host");
    this.cpu = new MetricRow("Процессор");
    this.memory = new MetricRow("Оперативная память");
    this.swap = new MetricRow("Файл подкачки");
    this.disk = new MetricRow("Диск");
    this.swapNote = div("bb-ss-note");
    this.swapNote.hidden = true;

    const foot = div("bb-ss-foot");
    this.loadAvg = div("");
    this.uptime = div("");
    this.booted = div("");
    foot.append(this.loadAvg, this.uptime, this.booted);

    this.stale = div("bb-ss-stale", "Последний опрос не прошёл — цифры могли устареть.");
    this.stale.hidden = true;

    node.append(
      div("bb-ss-title", "Состояние сервера"),
      this.host,
      this.cpu.root,
      this.memory.root,
      this.swap.root,
      this.swapNote,
      this.disk.root,
      foot,
      this.stale,
    );
    return node;
  }

  open(anchor: HTMLElement, snapshot: Snapshot | null, stale: boolean): void {
    if (this.node) {
      this.anchor = anchor;
      this.update(snapshot, stale);
      return;
    }
    this.anchor = anchor;
    const node = this.build();
    // Прячем за экраном, пока не известна высота.
    node.style.left = "-9999px";
    node.style.top = "0";
    document.body.append(node);
    this.node = node;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Клик по самой кнопке разбирает её собственный обработчик.
      if (node.contains(target) || anchor.contains(target)) return;
      this.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.close();
      // Фокус возвращаем кнопке: окно закрыли с клавиатуры.
      anchor.focus?.();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", this.close);
    this.cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKeyDown, true),
      () => window.removeEventListener("resize", this.close),
    );

    this.update(snapshot, stale);
  }

  close = (): void => {
    if (!this.node) return;
    for (const off of this.cleanup.splice(0)) off();
    this.node.remove();
    this.node = null;
    this.anchor = null;
    this.onClose();
  };

  /** Перерисовка по свежему снимку — окно может быть открыто во время опроса. */
  update(snapshot: Snapshot | null, stale: boolean): void {
    if (!this.node) return;

    if (!snapshot) {
      this.host.textContent = "Жду первый замер…";
      for (const row of [this.cpu, this.memory, this.swap, this.disk]) {
        row.hidden = true;
      }
      this.swapNote.hidden = true;
      this.loadAvg.textContent = "";
      this.uptime.textContent = "";
      this.booted.textContent = "";
      this.stale.hidden = !stale;
      this.place();
      return;
    }

    this.host.textContent = `${snapshot.osName} · ядро ${snapshot.kernel}`;

    this.cpu.hidden = false;
    this.cpu.update(
      snapshot.cpu,
      `${snapshot.cores} ${plural(snapshot.cores, "ядро", "ядра", "ядер")}`,
    );

    const memory = snapshot.memory;
    const inMemory = scale(memory.usedBytes, memory.totalBytes);
    this.memory.hidden = false;
    this.memory.update(
      memory.percent,
      `занято ${inMemory.format(memory.usedBytes)} из` +
        ` ${inMemory.format(memory.totalBytes)} ${inMemory.unit}`,
    );

    const swap = snapshot.swap;
    this.swap.hidden = swap === null;
    this.swapNote.hidden = true;
    if (swap) {
      const inSwap = scale(swap.usedBytes, swap.totalBytes);
      this.swap.update(
        swap.percent,
        `занято ${inSwap.format(swap.usedBytes)} из` +
          ` ${inSwap.format(swap.totalBytes)} ${inSwap.unit}`,
      );
      // Отдельный предупреждающий пункт: подкачка — это память, вытесненная
      // на диск. Проценты сами по себе ничего не объясняют, поэтому под
      // строкой появляется предупреждение словами.
      if (swap.percent >= WARN) {
        this.swapNote.hidden = false;
        this.swapNote.textContent =
          "Подкачка почти заполнена: оперативная память кончилась, сервер может заметно подтормаживать.";
      } else if (swap.percent >= SWAP_NOTE) {
        this.swapNote.hidden = false;
        this.swapNote.textContent =
          "Часть памяти вытеснена на диск — сервер уже не помещается в оперативную память.";
      }
    }

    const disk = snapshot.disk;
    this.disk.hidden = disk === null;
    if (disk) {
      const inDisk = scale(disk.usedBytes, disk.totalBytes, disk.availBytes);
      this.disk.update(
        disk.percent,
        `занято ${inDisk.format(disk.usedBytes)} из` +
          ` ${inDisk.format(disk.totalBytes)} ${inDisk.unit}` +
          ` · свободно ${inDisk.format(disk.availBytes)} ${inDisk.unit}`,
        // Корень подписывать незачем — это и так «Диск». Другую точку
        // монтирования показываем: без неё цифры не к чему привязать.
        disk.path === "/" ? "" : disk.path,
      );
    }

    // «1,5 / 1,4 / 0,9» без подписи читается как загадка: поясняем, что это
    // три окна усреднения и с чем их сравнивать — с числом ядер.
    const load = snapshot.load.map((value) => NUM1.format(value)).join(" / ");
    this.loadAvg.textContent =
      `Средняя нагрузка за 1, 5 и 15 минут: ${load}` +
      ` (перегрузка начинается с ${snapshot.cores})`;
    this.uptime.textContent = `Работает без перезагрузки: ${uptimeRu(uptimeSeconds(snapshot))}`;
    this.booted.textContent = `Последняя перезагрузка: ${bootedRu(snapshot.bootTimeMs)}`;
    this.stale.hidden = !stale;
    this.place();
  }

  /** Справа от кнопки, нижним краем по кнопке; в экран вписывается всегда. */
  place(): void {
    const node = this.node;
    const anchor = this.anchor;
    if (!node || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    // Если справа места нет (узкий экран) — уводим окно левее кнопки.
    const fitsRight = rect.right + 8 + size.width + 8 <= window.innerWidth;
    const preferred = fitsRight ? rect.right + 8 : rect.left - size.width - 8;
    // На узком экране сайдбар уезжает за левый край, и кнопка вместе с ним:
    // без нижней границы окно ушло бы следом и обрезалось краем экрана.
    const left = Math.min(
      Math.max(8, preferred),
      Math.max(8, window.innerWidth - size.width - 8),
    );
    const top = Math.min(
      Math.max(8, rect.bottom - size.height),
      Math.max(8, window.innerHeight - size.height - 8),
    );
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
}

// --- регистрация ------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: ACTION_ID,
    title: "Состояние сервера",
    icon: "Activity",
    // Мышь и тач кнопку перехватывает контент-скрипт, но клавиатурная
    // активация доходит сюда — событие открывает то же окно.
    run: () => {
      document.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });

  app.contentScripts.register({
    id: "footer-status",
    mount({ signal }) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);

      const ring = new Ring();
      let pinned = false;
      const panel = new Panel(() => {
        pinned = false;
      });
      let snapshot: Snapshot | null = null;
      let stale = false;
      let button: HTMLElement | null = null;
      // Инлайновый position кнопки до нас: кольцу нужен контекст
      // позиционирования, и на снятии значение возвращается как было.
      let restorePosition: string | null = null;
      // Указатель, чьё нажатие по кнопке мы уже отработали сами: его — и только
      // его — парный click надо погасить. Хранится id, а не голый флаг: жест
      // можно отменить (нажал на иконке, отпустил в стороне), тогда click по
      // кнопке не придёт вовсе, и взведённый флаг съел бы следующую
      // клавиатурную активацию.
      let suppressedPointer: number | null = null;
      let inFlight = false;
      let lastFetch = 0;

      const draw = () => ring.draw(snapshot ? snapshot.memory.percent : null);

      // Размер кнопки задаёт геометрию кольца: сайдбар умеет складываться.
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.contentRect;
          const target = entry.target as HTMLElement;
          ring.layout(target.offsetWidth || box.width, target.offsetHeight || box.height);
        }
        draw();
        panel.place();
      });

      const detach = () => {
        resizeObserver.disconnect();
        ring.node.remove();
        if (button && restorePosition !== null) button.style.position = restorePosition;
        restorePosition = null;
        button = null;
      };

      const attach = (next: HTMLElement) => {
        if (button === next && ring.node.parentNode === next) return;
        if (button !== next) detach();
        button = next;
        if (getComputedStyle(next).position === "static") {
          restorePosition = next.style.position;
          next.style.position = "relative";
        }
        // Свой свежесозданный узел в контейнер хоста класть можно — чужие
        // узлы не двигаются и не удаляются.
        next.append(ring.node);
        ring.layout(next.offsetWidth, next.offsetHeight);
        draw();
        resizeObserver.observe(next);
      };

      // Кнопку рисует хост, и к моменту старта скрипта её может не быть —
      // ждём появления, а заодно возвращаем кольцо, если React перерисовал
      // футер и унёс наш узел вместе со старой кнопкой.
      let scheduled = 0;
      const sync = () => {
        scheduled = 0;
        const found = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
        if (!found) {
          if (button) {
            panel.close();
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
        // кольцо на месте, ничего не делаем.
        if (button?.isConnected && ring.node.parentNode === button) return;
        schedule();
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      sync();

      const refresh = async (force = false): Promise<void> => {
        // Скрытая вкладка из опроса ничего не узнаёт, а каждая открытая иначе
        // продолжала бы дёргать тот же сервер.
        if (document.visibilityState === "hidden" || inFlight || signal.aborted) return;
        const now = Date.now();
        if (!force && now - lastFetch < MIN_GAP_MS) return;
        lastFetch = now;
        inFlight = true;
        try {
          snapshot = await fetchSnapshot(signal);
          stale = false;
        } catch {
          // Сервер может перезагружать плагин: держим прошлые цифры, помечаем
          // их как несвежие и ждём следующего тика. В консоль не шумим — раз в
          // пять секунд это была бы стена сообщений.
          stale = snapshot !== null;
        } finally {
          inFlight = false;
        }
        draw();
        panel.update(snapshot, stale);
      };

      void refresh(true);
      const timer = window.setInterval(() => void refresh(true), POLL_MS);

      // Вкладку вернули из фона — цифры там уже успели протухнуть.
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

      const toggle = () => {
        const anchor = button;
        if (!anchor) return;
        if (pinned) {
          panel.close();
          return;
        }
        pinned = true;
        void refresh();
        panel.open(anchor, snapshot, stale);
      };

      // Нажатие мышью или пальцем: открываем окно сами и гасим клик, иначе
      // хост вызовет `run` и окно закроется тут же следом.
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button !== 0 || !buttonFrom(event.target)) return;
          suppressedPointer = event.pointerId;
          toggle();
        },
        { capture: true, signal },
      );

      // Конец жеста. Отпустили на кнопке — сейчас придёт парный click, его и
      // гасит обработчик ниже. Отпустили мимо или жест отменили — клика по
      // кнопке не будет, и ожидание надо снять здесь же, иначе оно достанется
      // следующему нажатию Enter или пробела.
      const endGesture = (event: PointerEvent) => {
        if (suppressedPointer !== event.pointerId) return;
        if (event.type === "pointerup" && buttonFrom(event.target)) return;
        suppressedPointer = null;
      };
      document.addEventListener("pointerup", endGesture, { capture: true, signal });
      document.addEventListener("pointercancel", endGesture, { capture: true, signal });

      document.addEventListener(
        "click",
        (event) => {
          if (suppressedPointer === null || !buttonFrom(event.target)) return;
          suppressedPointer = null;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true, signal },
      );

      // Клавиатурная активация приходит из `run` слота.
      document.addEventListener(TOGGLE_EVENT, () => toggle(), { signal });

      return () => {
        if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
        window.clearInterval(timer);
        domObserver.disconnect();
        panel.close();
        detach();
        style.remove();
      };
    },
  });
});
