// bb-plugin-server-status — бэкенд: метрики хоста для иконки в футере сайдбара
// (кольцо вокруг неё) и для окна с подробностями.
//
// Одна фоновая служба опрашивает хост раз в 5 секунд и держит свежий снимок в
// памяти. Наружу снимок уходит единственным путём — rpc `state`: у контент-
// скрипта фронтенда нет React-хуков, а значит и `useRealtime`, поэтому он
// опрашивает, а не подписывается. Публиковать тот же снимок ещё и в realtime-
// канал незачем: подписчиков у него нет, а кадры в каждую вкладку шли бы даже
// тогда, когда вкладка скрыта и опрос молчит.
//
// Всё читается напрямую из Node: /proc для процессора и памяти, statfs для
// диска. Ни зависимостей, ни вызовов внешних команд.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { z } from "zod";

const TICK_MS = 5_000;
// Диск почти не меняется, а statfs здесь — самое дорогое чтение, поэтому он
// опрашивается в двенадцать раз реже процессора и памяти.
const DISK_TTL_MS = 60_000;
// Первое число по процессору требует двух замеров; это окно между ними.
// Достаточно короткое, чтобы индикатор успел заполниться до первого взгляда.
const WARMUP_MS = 300;

// --- чтение метрик ----------------------------------------------------------

type CpuSample = { total: number; idle: number };

// Первая строка /proc/stat — сумма по всем ядрам, в тиках:
// user nice system idle iowait irq softirq steal guest guest_nice.
// Загрузка — это дельта между двумя замерами, одно чтение не говорит ничего.
function readCpuSample(): CpuSample | null {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const first = stat.slice(0, stat.indexOf("\n"));
    if (!first.startsWith("cpu ")) return null;
    const fields = first.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
    const total = fields.reduce((sum, n) => sum + n, 0);
    // iowait считаем простоем: процессор ждёт, а не работает.
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    return { total, idle };
  } catch {
    return null;
  }
}

function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const busy = total - (next.idle - prev.idle);
  return round1(clampPercent((busy / total) * 100));
}

// Значения /proc/meminfo — в kB (на деле кибибайты, несмотря на подпись).
function readMeminfo(): Map<string, number> {
  const values = new Map<string, number>();
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = /^(\w+):\s+(\d+)/.exec(line);
      if (match) values.set(match[1]!, Number(match[2]) * 1024);
    }
  } catch {
    /* не Linux или procfs не смонтирован — вызывающий откатится на os */
  }
  return values;
}

type Usage = { percent: number; usedBytes: number; totalBytes: number };

// MemAvailable — собственная оценка ядра, сколько получил бы новый процесс;
// именно это человек и понимает под «занято». Один MemFree считает занятой
// каждую страницу страничного кэша и на простаивающей машине даёт 95%.
function readMemory(): Usage {
  const info = readMeminfo();
  const total = info.get("MemTotal") ?? os.totalmem();
  const available = info.get("MemAvailable") ?? os.freemem();
  if (!(total > 0)) return { percent: 0, usedBytes: 0, totalBytes: 0 };
  const used = Math.max(0, total - available);
  return { percent: round1((used / total) * 100), usedBytes: used, totalBytes: total };
}

function readSwap(): Usage | null {
  const info = readMeminfo();
  const total = info.get("SwapTotal") ?? 0;
  if (!(total > 0)) return null;
  const used = Math.max(0, total - (info.get("SwapFree") ?? 0));
  return { percent: round1((used / total) * 100), usedBytes: used, totalBytes: total };
}

type DiskUsage = Usage & { availBytes: number; path: string };

// Арифметика как у df(1): зарезервированные под root блоки (bfree - bavail)
// не заняты и не доступны, поэтому процент — used / (used + available).
// Деление на сырой total занижает результат на несколько пунктов.
function readDisk(path: string): DiskUsage | null {
  try {
    const fs = statfsSync(path);
    const block = Number(fs.bsize);
    const total = Number(fs.blocks) * block;
    const free = Number(fs.bfree) * block;
    const avail = Number(fs.bavail) * block;
    const used = Math.max(0, total - free);
    const base = used + avail;
    if (!(total > 0) || !(base > 0)) return null;
    return {
      percent: clampPercent(Math.ceil((used / base) * 100)),
      usedBytes: used,
      totalBytes: total,
      availBytes: avail,
      path,
    };
  } catch {
    return null;
  }
}

// PRETTY_NAME — то, как машину называет человек («Ubuntu 24.04.4 LTS»). Файл
// не меняется, пока сервер работает, поэтому читаем его один раз при загрузке.
function readOsName(): string {
  try {
    const match = /^PRETTY_NAME="?(.+?)"?$/m.exec(
      readFileSync("/etc/os-release", "utf8"),
    );
    if (match?.[1]) return match[1];
  } catch {
    /* не Linux или файла нет — откатываемся на то, что знает node */
  }
  return `${os.type()} ${os.release()}`;
}

// --- общие помощники --------------------------------------------------------

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

const round1 = (value: number): number => Math.round(value * 10) / 10;

// Завершается досрочно при остановке плагина: обычный setTimeout проспал бы
// окно остановки, и плагин отрапортовал бы «degraded».
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// --- контракт ---------------------------------------------------------------

const usageSchema = z.object({
  percent: z.number(),
  usedBytes: z.number(),
  totalBytes: z.number(),
});

const snapshotSchema = z.object({
  // null, пока не пришёл второй замер процессора, и там, где нет /proc/stat.
  cpu: z.number().nullable(),
  cores: z.number(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: usageSchema,
  swap: usageSchema.nullable(),
  disk: usageSchema.extend({ availBytes: z.number(), path: z.string() }).nullable(),
  uptimeSeconds: z.number(),
  // Версия ядра и человеческое имя ОС — статика, но панель их показывает.
  kernel: z.string(),
  osName: z.string(),
  // От этого момента фронтенд сам растит аптайм, не переспрашивая сервер.
  bootTimeMs: z.number(),
  updatedAt: z.number(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: snapshotSchema },
});

// --- плагин -----------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    diskPath: {
      type: "string",
      label: "Точка монтирования диска",
      default: "/",
    },
  });

  let diskPath = (await settings.get()).diskPath.trim() || "/";
  let diskCache: { at: number; value: DiskUsage | null } | null = null;
  let latest: Snapshot | null = null;

  settings.onChange((next) => {
    diskPath = next.diskPath.trim() || "/";
    diskCache = null; // следующий тик измерит новую точку монтирования
  });

  // os.cpus() обходит каждое ядро, поэтому число ядер берём один раз.
  const cores = os.cpus().length;
  const osName = readOsName();

  function disk(): DiskUsage | null {
    const now = Date.now();
    if (!diskCache || now - diskCache.at >= DISK_TTL_MS) {
      diskCache = { at: now, value: readDisk(diskPath) };
    }
    return diskCache.value;
  }

  function snapshot(cpu: number | null): Snapshot {
    const uptimeSeconds = Math.floor(os.uptime());
    const now = Date.now();
    const [one = 0, five = 0, fifteen = 0] = os.loadavg();
    return {
      cpu,
      cores,
      // Средняя нагрузка — только контекст для окна, это не загрузка ЦП:
      // на этом хосте /proc/stat показывал 11.7%, а loadavg1 — 8.09.
      load: [round1(one), round1(five), round1(fifteen)],
      memory: readMemory(),
      swap: readSwap(),
      disk: disk(),
      uptimeSeconds,
      kernel: os.release(),
      osName,
      bootTimeMs: now - uptimeSeconds * 1000,
      updatedAt: now,
    };
  }

  bb.rpc.register(rpcContract, {
    // Отдаёт снимок службы; запасной путь срабатывает лишь в первые доли
    // секунды после загрузки, пока служба не сделала первый тик.
    state: () => latest ?? snapshot(null),
  });

  // Одна служба на сервер, а не на клиента: все окна читают один и тот же
  // снимок, поэтому стоимость опроса не растёт с числом вкладок.
  bb.background.service("metrics", {
    async start(signal) {
      let previous = readCpuSample();
      await sleep(WARMUP_MS, signal);
      while (!signal.aborted) {
        const current = readCpuSample();
        const cpu = previous && current ? cpuPercent(previous, current) : null;
        if (current) previous = current;
        latest = snapshot(cpu);
        await sleep(TICK_MS, signal);
      }
    },
  });

  bb.log.info(`watching ${cores} cores, disk ${diskPath}, tick ${TICK_MS}ms`);
}
