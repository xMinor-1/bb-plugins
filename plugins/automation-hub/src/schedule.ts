// Pure schedule helpers: classify bb automations, describe cron in words,
// and build the cron and wrapper script for a watch. No bb or DOM imports,
// so the tests run them directly with `node --test`.

export type Kind = "watch" | "schedule" | "once";
export type Hours = "always" | "weekdays_9_19";

/** Watch intervals the hub offers, in seconds. 30 s runs twice inside a one-minute bb tick. */
export const WATCH_INTERVALS = [30, 60, 300, 600, 900, 1800, 3600] as const;
export type WatchInterval = (typeof WATCH_INTERVALS)[number];

export type Lang = "en" | "ru";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_SHORT_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DAY_EVERY_RU = ["По воскресеньям", "По понедельникам", "По вторникам", "По средам", "По четвергам", "По пятницам", "По субботам"];

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface CronFields {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

export function splitCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return { minute, hour, dom, month, dow };
}

/** Seconds between runs when a cron fires at least once an hour; otherwise null. */
export function cronEverySeconds(cron: string): number | null {
  const f = splitCron(cron);
  if (!f || f.dom !== "*" || f.month !== "*") return null;
  const hourly = f.hour === "*" || /^\d{1,2}-\d{1,2}$/.test(f.hour);
  if (!hourly) return null;
  if (f.minute === "*") return 60;
  const step = /^\*\/(\d{1,2})$/.exec(f.minute);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n < 60 ? n * 60 : null;
  }
  if (/^\d{1,2}$/.test(f.minute)) return 3600;
  return null;
}

/** Watches are frequent scripts; an agent task on a frequent cron is still a schedule. */
export function classify(trigger: { triggerType: string; cron?: string }, hubEverySeconds: number | null, mode: "agent" | "script"): Kind {
  if (trigger.triggerType === "once") return "once";
  if (hubEverySeconds) return "watch";
  return mode === "script" && trigger.cron && cronEverySeconds(trigger.cron) !== null ? "watch" : "schedule";
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** A five-field cron with numbers in range: `*`, `*\/n`, `a`, `a-b`, `a-b/n` and lists of them. */
export function validCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((field, i) => {
    const [lo, hi] = FIELD_RANGES[i]!;
    return field.split(",").every((item) => {
      const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(item);
      if (!m) return false;
      const step = m[4] === undefined ? null : Number(m[4]);
      if (step !== null && (step < 1 || step > hi)) return false;
      if (m[1] === "*") return true;
      const a = Number(m[2]);
      const b = m[3] === undefined ? a : Number(m[3]);
      return a >= lo && a <= hi && b >= lo && b <= hi && a <= b;
    });
  });
}

/** An agent task runs at most hourly: the minute must be one fixed number. */
export function agentCronTooFrequent(cron: string): boolean {
  const f = splitCron(cron);
  return !f || !/^\d{1,2}$/.test(f.minute);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timeOf(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return `${Number(hour)}:${pad(Number(minute))}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function daysText(dow: string, lang: Lang): string | null {
  const ru = lang === "ru";
  if (dow === "*") return null;
  if (dow === "1-5") return ru ? "По будням" : "Weekdays";
  if (dow === "0,6" || dow === "6,0") return ru ? "По выходным" : "Weekends";
  const list = dow.split(",");
  if (list.every((d) => /^[0-7]$/.test(d))) {
    const days = list.map((d) => Number(d) % 7);
    if (ru) return days.length === 1 ? DAY_EVERY_RU[days[0]!]! : capitalize(days.map((d) => DAY_SHORT_RU[d]!).join(", "));
    const names = days.map((d) => DAY_NAMES[d]!);
    return names.length === 1 ? `Every ${names[0]}` : names.join(", ");
  }
  return null;
}

/** "Weekdays 9:00–19:00" for an hour range plus weekday field, or null. */
export function hoursText(cron: string, lang: Lang = "en"): string | null {
  const f = splitCron(cron);
  if (!f) return null;
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(f.hour);
  const days = daysText(f.dow, lang);
  if (!range) return days === null ? null : days;
  const span = `${Number(range[1])}:00–${Number(range[2]) + 1}:00`;
  return days === null ? `${lang === "ru" ? "Ежедневно" : "Daily"} ${span}` : `${days} ${span}`;
}

export function everyText(seconds: number, lang: Lang = "en"): string {
  if (lang === "ru") {
    if (seconds < 60) return `Каждые ${seconds} с`;
    if (seconds === 60) return "Каждую минуту";
    if (seconds < 3600) return `Каждые ${seconds / 60} мин`;
    if (seconds === 3600) return "Каждый час";
    return `Каждые ${seconds / 3600} ч`;
  }
  if (seconds < 60) return `Every ${seconds} s`;
  if (seconds === 60) return "Every minute";
  if (seconds < 3600) return `Every ${seconds / 60} min`;
  if (seconds === 3600) return "Every hour";
  return `Every ${seconds / 3600} h`;
}

/** A short description of a five-field cron in English or Russian; falls back to the expression. */
export function describeCron(cron: string, lang: Lang = "en"): string {
  const ru = lang === "ru";
  const f = splitCron(cron);
  if (!f) return cron;
  const every = cronEverySeconds(cron);
  if (every !== null) return everyText(every, lang);
  const at = timeOf(f.minute, f.hour);
  const hourStep = /^\*\/(\d{1,2})$/.exec(f.hour);
  if (hourStep && /^\d{1,2}$/.test(f.minute) && f.dom === "*" && f.month === "*") {
    const days = daysText(f.dow, lang);
    return `${ru ? "Каждые" : "Every"} ${hourStep[1]} ${ru ? "ч" : "h"}${days ? `, ${days.toLowerCase()}` : ""}`;
  }
  if (at === null) return `cron ${cron}`;
  if (f.month !== "*") return `cron ${cron}`;
  if (f.dom !== "*") {
    const doms = f.dom.split(",");
    if (doms.every((d) => /^\d{1,2}$/.test(d)) && f.dow === "*") {
      const nums = doms.map(Number);
      if (ru) {
        const list = nums.length === 1 ? `${nums[0]}` : `${nums.slice(0, -1).join(", ")} и ${nums[nums.length - 1]}`;
        return `Каждый месяц ${list} числа в ${at}`;
      }
      const list = nums.map(ordinal);
      return `Monthly on the ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`} at ${at}`;
    }
    return `cron ${cron}`;
  }
  if (f.dow === "*") return ru ? `Каждый день в ${at}` : `Every day at ${at}`;
  const days = daysText(f.dow, lang);
  if (days === null) return `cron ${cron}`;
  return `${days} ${ru ? "в" : "at"} ${at}`;
}

/** Cron for a watch interval and active hours. Sub-minute intervals tick every minute. */
export function watchCron(everySeconds: number, hours: Hours): string {
  const minute =
    everySeconds <= 60 ? "*" : everySeconds >= 3600 ? "0" : `*/${Math.round(everySeconds / 60)}`;
  return hours === "weekdays_9_19" ? `${minute} 9-18 * * 1-5` : `${minute} * * * *`;
}

export type Interpreter = "bash" | "python3" | "node";

const EXT: Record<Interpreter, string> = { bash: "sh", python3: "py", node: "mjs" };

/**
 * Wraps a check so it runs every `everySeconds` (< 60) inside one bb tick:
 * the check runs, the wrapper sleeps the rest of the interval, the check runs
 * again. Output of both passes goes to stdout; the run fails only when every
 * pass failed.
 */
export function subMinuteWrapper(check: string, interpreter: Interpreter, everySeconds: number): string {
  let marker = "BB_HUB_CHECK";
  for (let i = 0; check.includes(marker); i++) marker = `BB_HUB_CHECK_${i}`;
  const passes = Math.max(1, Math.floor(60 / everySeconds));
  return [
    "#!/usr/bin/env bash",
    `# Automation Hub watch: the check below runs every ${everySeconds} s inside a one-minute tick.`,
    "set -u",
    // A directory, not a file with a suffix: BSD mktemp on macOS fills only trailing X's.
    `dir="$(mktemp -d "\${TMPDIR:-/tmp}/bb-hub-check.XXXXXX")" || exit 1`,
    `check="$dir/check.${EXT[interpreter]}"`,
    `trap 'rm -rf "$dir"' EXIT`,
    `cat > "$check" <<'${marker}'`,
    check.endsWith("\n") ? check.slice(0, -1) : check,
    marker,
    "failed=0",
    `for pass in $(seq 1 ${passes}); do`,
    "  start=$(date +%s)",
    `  ${interpreter} "$check" || failed=$((failed + 1))`,
    `  if [ "$pass" -lt ${passes} ]; then`,
    `    rest=$(( ${everySeconds} - ($(date +%s) - start) ))`,
    '    if [ "$rest" -gt 0 ]; then sleep "$rest"; fi',
    "  fi",
    "done",
    `if [ "$failed" -ge ${passes} ]; then exit 1; fi`,
    "exit 0",
    "",
  ].join("\n");
}

/** Recent run statuses as strip cells, oldest first: n = nothing new, h = fired, e = failed, r = running. */
export function stripOf(runs: { status: string; output: string | null }[]): string {
  return runs
    .map((r) =>
      r.status === "running" ? "r" : r.status === "failed" ? "e" : r.status === "succeeded" && (r.output ?? "").trim() !== "" ? "h" : "n",
    )
    .reverse()
    .join("");
}
