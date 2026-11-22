import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  agentCronTooFrequent,
  classify,
  cronEverySeconds,
  describeCron,
  everyText,
  hoursText,
  stripOf,
  subMinuteWrapper,
  validCron,
  watchCron,
} from "../src/schedule.ts";

describe("cronEverySeconds", () => {
  it("reads minute steps and hour ranges", () => {
    assert.equal(cronEverySeconds("* * * * *"), 60);
    assert.equal(cronEverySeconds("*/5 * * * *"), 300);
    assert.equal(cronEverySeconds("*/10 9-18 * * 1-5"), 600);
    assert.equal(cronEverySeconds("0 * * * *"), 3600);
  });
  it("returns null for daily and monthly schedules", () => {
    assert.equal(cronEverySeconds("0 9 * * *"), null);
    assert.equal(cronEverySeconds("0 9 * * 1-5"), null);
    assert.equal(cronEverySeconds("0 11 5,20 * *"), null);
    assert.equal(cronEverySeconds("0 */4 * * *"), null);
    assert.equal(cronEverySeconds("bad"), null);
  });
});

describe("classify", () => {
  it("separates watches, schedules and one-time jobs", () => {
    assert.equal(classify({ triggerType: "once" }, null, "agent"), "once");
    assert.equal(classify({ triggerType: "schedule", cron: "*/2 * * * *" }, null, "script"), "watch");
    assert.equal(classify({ triggerType: "schedule", cron: "0 9 * * 1" }, null, "script"), "schedule");
    assert.equal(classify({ triggerType: "schedule", cron: "* * * * *" }, 30, "script"), "watch");
  });
  it("keeps an hourly agent task among schedules", () => {
    assert.equal(classify({ triggerType: "schedule", cron: "0 9-17 * * 1-5" }, null, "agent"), "schedule");
  });
});

describe("validCron and agentCronTooFrequent", () => {
  it("accepts real crons and rejects out-of-range ones", () => {
    for (const ok of ["0 9 * * 1-5", "*/5 * * * *", "30 8 1,15 * *", "0 */4 * * 0,6", "0 9-18/3 * * *"]) assert.equal(validCron(ok), true, ok);
    for (const bad of ["99 99 * * *", "0 24 * * *", "0 9 * * 8", "0 9 0 * *", "0 9", "a b c d e", "0 18-9 * * *", "*/0 * * * *"]) assert.equal(validCron(bad), false, bad);
  });
  it("lets an agent task run at most hourly", () => {
    assert.equal(agentCronTooFrequent("0 9 * * 1-5"), false);
    assert.equal(agentCronTooFrequent("15 * * * *"), false);
    assert.equal(agentCronTooFrequent("* 9 * * *"), true);
    assert.equal(agentCronTooFrequent("*/10 * * * *"), true);
  });
});

describe("describeCron", () => {
  it("says common schedules in words", () => {
    assert.equal(describeCron("0 9 * * *"), "Every day at 9:00");
    assert.equal(describeCron("30 8 * * 1-5"), "Weekdays at 8:30");
    assert.equal(describeCron("0 10 * * 1"), "Every Mon at 10:00");
    assert.equal(describeCron("0 11 5,20 * *"), "Monthly on the 5th and 20th at 11:00");
    assert.equal(describeCron("0 */4 * * *"), "Every 4 h");
    assert.equal(describeCron("*/15 * * * *"), "Every 15 min");
  });
  it("falls back to the expression", () => {
    assert.equal(describeCron("0 9 1 1 *"), "cron 0 9 1 1 *");
    assert.equal(describeCron("nope"), "nope");
  });
});

describe("Russian texts", () => {
  it("describes schedules in Russian", () => {
    assert.equal(describeCron("0 9 * * *", "ru"), "Каждый день в 9:00");
    assert.equal(describeCron("30 8 * * 1-5", "ru"), "По будням в 8:30");
    assert.equal(describeCron("0 10 * * 1", "ru"), "По понедельникам в 10:00");
    assert.equal(describeCron("0 10 * * 1,3", "ru"), "Пн, ср в 10:00");
    assert.equal(describeCron("0 11 5,20 * *", "ru"), "Каждый месяц 5 и 20 числа в 11:00");
    assert.equal(describeCron("0 */4 * * 1-5", "ru"), "Каждые 4 ч, по будням");
    assert.equal(describeCron("*/15 * * * *", "ru"), "Каждые 15 мин");
  });
  it("describes intervals and hours in Russian", () => {
    assert.equal(everyText(30, "ru"), "Каждые 30 с");
    assert.equal(everyText(60, "ru"), "Каждую минуту");
    assert.equal(everyText(3600, "ru"), "Каждый час");
    assert.equal(hoursText("*/5 9-18 * * 1-5", "ru"), "По будням 9:00–19:00");
    assert.equal(hoursText("* 9-18 * * *", "ru"), "Ежедневно 9:00–19:00");
  });
});

describe("hoursText and everyText", () => {
  it("describes active hours", () => {
    assert.equal(hoursText("*/5 9-18 * * 1-5"), "Weekdays 9:00–19:00");
    assert.equal(hoursText("* 9-18 * * *"), "Daily 9:00–19:00");
    assert.equal(hoursText("* * * * *"), null);
  });
  it("describes intervals", () => {
    assert.equal(everyText(30), "Every 30 s");
    assert.equal(everyText(60), "Every minute");
    assert.equal(everyText(600), "Every 10 min");
    assert.equal(everyText(3600), "Every hour");
  });
});

describe("watchCron", () => {
  it("maps intervals and hours to cron", () => {
    assert.equal(watchCron(30, "always"), "* * * * *");
    assert.equal(watchCron(60, "always"), "* * * * *");
    assert.equal(watchCron(300, "weekdays_9_19"), "*/5 9-18 * * 1-5");
    assert.equal(watchCron(3600, "always"), "0 * * * *");
  });
  it("round-trips through cronEverySeconds", () => {
    for (const every of [60, 300, 600, 900, 1800, 3600]) {
      assert.equal(cronEverySeconds(watchCron(every, "always")), every);
    }
  });
});

describe("stripOf", () => {
  it("turns newest-first runs into oldest-first cells", () => {
    const runs = [
      { status: "running", output: null },
      { status: "succeeded", output: "new file a.txt\n" },
      { status: "failed", output: null },
      { status: "succeeded", output: "  " },
    ];
    assert.equal(stripOf(runs), "nehr");
    assert.equal(stripOf([]), "");
  });
});

describe("subMinuteWrapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-wrapper-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (script: string) => {
    const file = join(dir, `w${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, script);
    return spawnSync("bash", [file], { cwd: dir, encoding: "utf8", timeout: 20_000 });
  };

  it("is valid bash and keeps a check that contains the default marker", () => {
    const check = "echo BB_HUB_CHECK inside\n";
    const script = subMinuteWrapper(check, "bash", 59);
    assert.match(script, /<<'BB_HUB_CHECK_0'/);
    execFileSync("bash", ["-n", "-c", script]);
    const r = run(script);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "BB_HUB_CHECK inside\n");
  });

  it("runs one pass per tick for 59 s and fails only when the check failed", () => {
    assert.equal(run(subMinuteWrapper("exit 3", "bash", 59)).status, 1);
    assert.equal(run(subMinuteWrapper("echo ok", "bash", 59)).status, 0);
  });

  it("runs python and node checks", () => {
    assert.equal(run(subMinuteWrapper("print('py finding')", "python3", 59)).stdout, "py finding\n");
    assert.equal(run(subMinuteWrapper("console.log('node finding')", "node", 59)).stdout, "node finding\n");
  });

  it("plans two passes for 30 s", () => {
    const script = subMinuteWrapper("true", "bash", 30);
    assert.match(script, /seq 1 2/);
    assert.match(script, /rest=\$\(\( 30 - /);
  });
});
