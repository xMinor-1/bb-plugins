// End-to-end check of the masking bar on an isolated bb in docker.
//
// Setup (see the PR for the exact commands):
// - bb in a node:24-bookworm container with `--memory` and `--oom-score-adj=1000`,
//   Claude Code and Codex installed with `npm i -g`, a fake ANTHROPIC_API_KEY;
// - this plugin installed by path, `binaryPath` set to `e2e/fake-proxy` copied
//   into the container, `corporateModels` set to `claude-sonnet`;
// - three threads: Claude Code on Opus (routed), Claude Code on Sonnet
//   (in-network), Codex (not routed).
// Run from a directory with playwright-core:
//   BASE=http://127.0.0.1:<port> SHOTS=<dir> \
//   THREADS='{"project":"proj_…","routed":"thr_…","corp":"thr_…","codex":"thr_…"}' node masking-bar.mjs
import { chromium } from "playwright-core";

const BASE = process.env.BASE;
const THREADS = JSON.parse(process.env.THREADS); // {routed, corp, codex}
const SHOTS = process.env.SHOTS;
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
});

async function openThread(page, project, id) {
  await page.goto(`${BASE}/projects/${project}/threads/${id}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-masking-state]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
}

async function bar(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-masking-state]");
    const led = el?.querySelector("[data-led]");
    return {
      state: el?.getAttribute("data-masking-state"),
      tag: el?.tagName,
      text: el?.textContent?.trim(),
      led: led?.getAttribute("data-led"),
      ledBox: led ? JSON.stringify(led.getBoundingClientRect()) : null,
      switches: document.querySelectorAll('[role="switch"]').length,
      overflow: el ? el.scrollWidth > el.clientWidth : null,
    };
  });
}

async function tipAfterHover(page) {
  const el = page.locator("[data-masking-state]").first();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await el.hover();
  await page.waitForTimeout(200);
  const early = await page.locator("[data-masking-tip]").count();
  await page.waitForTimeout(600);
  const tip = page.locator("[data-masking-tip]");
  const late = await tip.count();
  const text = late ? (await tip.innerText()).replace(/\n/g, " | ") : "";
  const box = late ? await tip.boundingBox() : null;
  const vw = page.viewportSize().width;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(100);
  const gone = (await page.locator("[data-masking-tip]").count()) === 0;
  return { early, late, text, inside: box ? box.x >= 0 && box.x + box.width <= vw : false, gone };
}

const EXPECT = {
  en: {
    title: "Masking",
    corp: "The model works inside your company's network, masking is not needed",
    codex: "Masking is not available for this agent yet",
    on: "Requests are masked before they leave",
    off: "Masking is off, requests leave as they are",
  },
  ru: {
    title: "Маскировка",
    corp: "Модель работает внутри сети компании, маскировка не нужна",
    codex: "Для этого агента маскировка пока недоступна",
    on: "Запросы маскируются перед отправкой",
    off: "Маскировка выключена, запросы уходят как есть",
  },
};

for (const [lang, scheme] of [["en", "light"], ["ru", "dark"]]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, locale: lang });
  await context.route("http://127.0.0.1:38887/**", (r) => r.abort());
  await context.addInitScript((l) => localStorage.setItem("xminor-plugins.lang", l), lang);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: /Skip setup/i });
  await skip.waitFor({ timeout: 20000 }).catch(() => {});
  if (await skip.count()) {
    await skip.click();
    await page.waitForTimeout(2000);
  }
  const e = EXPECT[lang];
  const P = THREADS.project;

  // 3. Agent not routed (Codex): muted, no switch, reason in the tooltip.
  await openThread(page, P, THREADS.codex);
  let b = await bar(page);
  check(`${lang} codex: bar visible, grey, short`, b.state === "unavailable" && b.led === "idle" && b.text === e.title, JSON.stringify(b));
  check(`${lang} codex: no switch`, b.switches === 0);
  let t = await tipAfterHover(page);
  check(`${lang} codex: tooltip after delay`, t.early === 0 && t.late === 1 && t.text === e.codex && t.inside && t.gone, JSON.stringify(t));
  await page.screenshot({ path: `${SHOTS}/${lang}-codex.png` });

  // 2. In-network model: muted, no switch, reason in the tooltip.
  await openThread(page, P, THREADS.corp);
  b = await bar(page);
  check(`${lang} corp: bar visible, grey`, b.state === "in-network" && b.led === "idle" && b.text === e.title, JSON.stringify(b));
  check(`${lang} corp: no switch`, b.switches === 0);
  await page.locator("[data-masking-state]").first().click();
  await page.waitForTimeout(300);
  check(`${lang} corp: click opens no feed`, (await page.locator("ul.divide-y").count()) === 0);
  t = await tipAfterHover(page);
  check(`${lang} corp: tooltip after delay`, t.early === 0 && t.late === 1 && t.text === e.corp && t.inside, JSON.stringify(t));
  await page.screenshot({ path: `${SHOTS}/${lang}-corp.png` });

  // 1. Routed external model (Claude Code): green LED, switch, feed.
  await openThread(page, P, THREADS.routed);
  await page.waitForFunction(() => document.querySelector("[data-masking-state]")?.getAttribute("data-masking-state") !== "loading");
  b = await bar(page);
  if (b.state === "off") {
    await page.locator('[role="switch"]').click();
    await page.waitForFunction(() => document.querySelector("[data-masking-state]")?.getAttribute("data-masking-state") === "on", null, { timeout: 10000 });
    b = await bar(page);
  }
  check(`${lang} routed: green LED, switch`, b.state === "on" && b.led === "on" && b.text === e.title && b.switches === 1, JSON.stringify(b));
  t = await tipAfterHover(page);
  check(`${lang} routed: tooltip on`, t.late === 1 && t.text.startsWith(e.on), JSON.stringify(t));
  await page.screenshot({ path: `${SHOTS}/${lang}-routed-on.png` });
  await page.locator("button[data-masking-state]").click();
  await page.waitForTimeout(800);
  const feedText = await page.evaluate(() => document.body.innerText);
  check(`${lang} routed: click opens details`, /Masking proxy is running|Прокси маскировки работает/.test(feedText));
  await page.screenshot({ path: `${SHOTS}/${lang}-routed-details.png` });
  await page.locator("button[data-masking-state]").click();
  await page.locator('[role="switch"]').click();
  await page.waitForFunction(() => document.querySelector("[data-masking-state]")?.getAttribute("data-masking-state") === "off", null, { timeout: 10000 });
  b = await bar(page);
  check(`${lang} routed: switch off → amber`, b.led === "off", JSON.stringify(b));
  t = await tipAfterHover(page);
  check(`${lang} routed: tooltip off`, t.text === e.off, JSON.stringify(t));
  await page.screenshot({ path: `${SHOTS}/${lang}-routed-off.png` });
  await page.locator('[role="switch"]').click();
  await page.waitForFunction(() => document.querySelector("[data-masking-state]")?.getAttribute("data-masking-state") === "on", null, { timeout: 10000 });

  for (const width of [900, 600, 400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const el = document.querySelector("[data-masking-state]");
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { right: box.right, vw: innerWidth, overflow: el.scrollWidth > el.clientWidth };
    });
    check(`${lang} routed: fits at ${width}px`, r !== null && r.right <= r.vw && !r.overflow, JSON.stringify(r));
  }
  check(`${lang}: no page errors`, errors.length === 0, errors.join("; "));
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
