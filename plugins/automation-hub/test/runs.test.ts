import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { RUN_LABEL, runVerdict, skipReasonText } from "../src/runs.ts";

const run = (status: string, output: string | null = null, skipReason: string | null = null) => ({ status, output, skipReason });

describe("runVerdict", () => {
  it("reads a quiet check of a watch as nothing new", () => {
    assert.equal(runVerdict(run("skipped", null, "empty output"), "watch"), "quiet");
    assert.equal(runVerdict(run("skipped", null, "wakeAgent false"), "watch"), "quiet");
    assert.equal(runVerdict(run("succeeded", "  \n"), "watch"), "quiet");
  });
  it("keeps a real skip of a watch a skip", () => {
    assert.equal(runVerdict(run("skipped", null, "interrupted: the server restarted while the script was running"), "watch"), "skipped");
    assert.equal(runVerdict(run("skipped", null, null), "watch"), "skipped");
  });
  it("reads output of a watch as a finding", () => {
    assert.equal(runVerdict(run("succeeded", "price dropped to 95\n"), "watch"), "found");
  });
  it("does not change schedules and one-time jobs", () => {
    for (const kind of ["schedule", "once"]) {
      assert.equal(runVerdict(run("skipped", null, "empty output"), kind), "skipped", kind);
      assert.equal(runVerdict(run("succeeded", "report saved"), kind), "done", kind);
      assert.equal(runVerdict(run("succeeded", null), kind), "done", kind);
    }
  });
  it("keeps running and failed as they are", () => {
    assert.equal(runVerdict(run("running"), "watch"), "running");
    assert.equal(runVerdict(run("failed", null, null), "watch"), "failed");
    assert.equal(runVerdict(run("failed"), "schedule"), "failed");
  });
});

describe("skipReasonText", () => {
  it("says the reasons bb writes in words", () => {
    assert.equal(skipReasonText("interrupted: the server restarted while the script was running", "ru"), "Прерван: bb перезапустился, пока шёл скрипт");
    assert.equal(skipReasonText("interrupted: thread thr_abc123 was archived", "ru"), "Прерван: чат запуска в архиве");
    assert.equal(skipReasonText("interrupted: thread thr_abc123 was deleted"), "Interrupted: the run's chat was deleted");
    assert.equal(skipReasonText("a retry (provider overloaded) is queued in thread thr_x", "ru"), "Повтор упавшего запуска уже ждёт в его чате");
    assert.equal(skipReasonText("failed run run_1 is not re-run: no longer exists"), "The failed run is not repeated: no longer exists");
    assert.equal(skipReasonText("empty output", "ru"), "Скрипт ничего не вывел");
  });
  it("shows an unknown reason as it came", () => {
    assert.equal(skipReasonText("something new from bb", "ru"), "something new from bb");
  });
});

describe("run labels on the page", () => {
  // messages.ts imports the plugin's i18n through the "@/" alias, so its Russian texts are read from the source:
  // the second object of defineMessages(en, {...}).
  const ru = readFileSync(new URL("../src/messages.ts", import.meta.url), "utf8").split("defineMessages(en, {")[1];
  const text = (key: string) => ru.match(new RegExp(`\\n  ${key}: "([^"]+)"`))?.[1];
  const label = (r: ReturnType<typeof run>, kind: string) => text(RUN_LABEL[runVerdict(r, kind)]);

  it("names a quiet check, a real skip and a finding", () => {
    assert.equal(label(run("skipped", null, "empty output"), "watch"), "Нового нет");
    assert.equal(label(run("skipped", null, "wakeAgent false"), "watch"), "Нового нет");
    assert.equal(label(run("skipped", null, "interrupted: the server restarted while the script was running"), "watch"), "Пропущен");
    assert.equal(label(run("succeeded", "new file a.txt"), "watch"), "Нашлось");
    assert.equal(label(run("skipped", null, "empty output"), "schedule"), "Пропущен");
  });
  it("has a text for every verdict", () => {
    for (const key of Object.values(RUN_LABEL)) assert.ok(text(key), key);
  });
});
