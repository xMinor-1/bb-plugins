// How a run of an automation reads on the page: its verdict and, for a real skip, the reason in words.
import type { Lang } from "./schedule.ts";

export type RunFacts = { status: string; output: string | null; skipReason: string | null };
export type RunVerdict = "found" | "quiet" | "done" | "failed" | "running" | "skipped";

/**
 * bb records a script run that printed nothing, or printed {"wakeAgent": false} last, as skipped with one of these.
 * For a watch that is the normal "checked, nothing new": a check is taught to print nothing when there is nothing to tell.
 */
const QUIET_REASONS = new Set(["empty output", "wakeAgent false"]);

export function runVerdict(run: RunFacts, kind: string): RunVerdict {
  if (run.status === "running") return "running";
  if (run.status === "failed") return "failed";
  const printed = (run.output ?? "").trim() !== "";
  if (kind === "watch") {
    if (run.status === "succeeded") return printed ? "found" : "quiet";
    if (run.status === "skipped" && QUIET_REASONS.has((run.skipReason ?? "").trim())) return "quiet";
  }
  return run.status === "succeeded" ? "done" : "skipped";
}

/** The message that names each verdict on the page (src/messages.ts). */
export const RUN_LABEL = {
  found: "runsFound",
  quiet: "runsQuiet",
  done: "runsDone",
  failed: "runsFailed",
  running: "runsRunning",
  skipped: "runsSkipped",
} as const satisfies Record<RunVerdict, string>;

type Rule = { re: RegExp; en: (m: RegExpMatchArray) => string; ru: (m: RegExpMatchArray) => string };

// The reasons bb writes (built-in Automations plugin); anything else is shown as it came.
const RULES: Rule[] = [
  { re: /^empty output$/, en: () => "The script printed nothing", ru: () => "Скрипт ничего не вывел" },
  { re: /^wakeAgent false$/, en: () => "The script asked not to wake the agent", ru: () => "Скрипт попросил не будить агента" },
  {
    re: /^interrupted: the server restarted while the script was running$/,
    en: () => "Interrupted: bb restarted while the script was running",
    ru: () => "Прерван: bb перезапустился, пока шёл скрипт",
  },
  {
    re: /^interrupted: the server restarted before a thread was attached$/,
    en: () => "Interrupted: bb restarted before the run's chat opened",
    ru: () => "Прерван: bb перезапустился до того, как открылся чат запуска",
  },
  {
    re: /^interrupted: the automations plugin stopped before the script finished$/,
    en: () => "Interrupted: bb's automations stopped before the script finished",
    ru: () => "Прерван: автоматизации bb остановились до конца скрипта",
  },
  { re: /^interrupted: thread \S+ no longer exists$/, en: () => "Interrupted: the run's chat no longer exists", ru: () => "Прерван: чата запуска больше нет" },
  { re: /^interrupted: thread \S+ was deleted$/, en: () => "Interrupted: the run's chat was deleted", ru: () => "Прерван: чат запуска удалён" },
  { re: /^interrupted: thread \S+ was archived$/, en: () => "Interrupted: the run's chat was archived", ru: () => "Прерван: чат запуска в архиве" },
  {
    re: /^a retry \(.*\) is queued in thread \S+$/s,
    en: () => "A retry of the failed run is already queued in its chat",
    ru: () => "Повтор упавшего запуска уже ждёт в его чате",
  },
  { re: /^a retry of the failed turn ran in thread \S+$/, en: () => "The failed run was already retried in its chat", ru: () => "Упавший запуск уже повторили в его чате" },
  { re: /^failed run \S+ is not re-run: (.*)$/s, en: (m) => `The failed run is not repeated: ${m[1]}`, ru: (m) => `Упавший запуск не повторяется: ${m[1]}` },
];

export function skipReasonText(reason: string, lang: Lang = "en"): string {
  const text = reason.trim();
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) return rule[lang](m);
  }
  return text;
}
