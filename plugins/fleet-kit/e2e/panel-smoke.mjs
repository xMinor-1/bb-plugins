// Clicks through the Fleet Kit panel in a headless browser inside the e2e
// container: renders, Sync now, remove a secret and enter it again through the
// form, then the same panel in Russian. Prints one line per check; exits 1
// when any check fails.
//
// Inside the container, after the README's e2e steps:
//   node ~/pw/panel-smoke.mjs   (playwright-core in ~/pw, Chromium from apt)
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:38886";
const home = process.env.HOME;
const key = readFileSync(`${home}/.fk-e2e/expected-key`, "utf8").trim();
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const visible = (locator) => locator.first().isVisible();

// English texts of the panel that must not show up in the Russian panel.
const ENGLISH = [
  "Sync now", "Syncing…", "Last sync", "Secrets", "Show all", "Only changes", "Not set", "Replace", "Remove",
  "Save", "Cancel", "Dismiss", "Reset lock", "Up to date", "Changes applied", "Applied with warnings",
  "Not synced yet", "Models:", "Manifest:", "Default model", "Saved in", "Everything matches",
  "the build allows only", "Turned off", "Installed", "Already", "Interface language",
];
// Names that stay as they are in any language.
const NAMES = new Set(["Fleet", "Kit", "OpenCode", "E2E", "build", "bb", "corp", "Corp", "gateway", "fake", "EN", "RU", "Large", "Small"]);

async function panelText(page, groupName) {
  const panel = page.getByRole("group", { name: groupName }).locator("xpath=ancestor::div[contains(@class, 'max-w-3xl')]");
  return panel.first().innerText();
}

// Buttons whose text overflows them, or that stick out past the panel or the window.
async function overflowing(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("div.max-w-3xl");
    const edge = Math.min(window.innerWidth, panel ? panel.getBoundingClientRect().right : window.innerWidth);
    return [...document.querySelectorAll("div.max-w-3xl button")]
      .filter((button) => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1
        || button.getBoundingClientRect().right > edge + 1)
      .map((button) => button.innerText.trim());
  });
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${base}/plugins/fleet-kit/status`, { waitUntil: "networkidle" });
  // A fresh bb opens its first-run setup instead of the requested page; it
  // can render after the network is idle, so wait for either screen.
  const skip = page.getByText("Skip setup");
  await page.getByRole("button", { name: "Sync now" }).or(skip).first().waitFor({ timeout: 60_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.goto(`${base}/plugins/fleet-kit/status`, { waitUntil: "networkidle" });
  }
  await page.getByRole("button", { name: "Sync now" }).waitFor({ timeout: 60_000 });
  check("panel renders", true);
  check("build shown", await visible(page.getByText("E2E build")));
  check("OpenCode version shown", await visible(page.getByText("2.2.5")));
  check("models line", await visible(page.getByText(/Models: only corp/)));

  await page.getByRole("button", { name: "Sync now" }).click();
  const started = await page.getByRole("button", { name: "Syncing…" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check("sync starts", started);
  await page.getByRole("button", { name: "Sync now" }).waitFor({ timeout: 180_000 });
  check("sync finishes", true);

  await page.getByRole("button", { name: "Remove" }).click();
  const field = page.getByLabel("Gateway key");
  await field.waitFor({ timeout: 15_000 });
  check("secret removed", await visible(page.getByText("Not set")));
  await field.fill(key);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText(/Saved in/).first().waitFor({ timeout: 15_000 });
  check("secret saved through the form", true);
  check("secret value absent from the page", !(await page.content()).includes(key));

  await page.screenshot({ path: `${home}/.fk-e2e/panel.png`, fullPage: true });
  check("English buttons fit", (await overflowing(page)).length === 0, (await overflowing(page)).join(", "));

  // Russian: the switch in the header, the whole panel, and back.
  await page.getByRole("group", { name: "Interface language" }).getByRole("button", { name: "RU" }).click();
  await page.getByRole("button", { name: "Сверить сейчас" }).waitFor({ timeout: 10_000 });
  check("switch to Russian", true);
  check("language saved", (await page.evaluate(() => localStorage.getItem("xminor-plugins.lang"))) === "ru");
  check("agent notice in Russian", await visible(page.getByText(/снова его выключил/)));
  await page.getByRole("button", { name: "Сверить сейчас" }).click();
  check("sync starts in Russian", await page.getByRole("button", { name: "Сверяю…" }).waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await page.getByRole("button", { name: "Сверить сейчас" }).waitFor({ timeout: 180_000 });
  const showAll = page.getByRole("button", { name: "Показать всё" });
  if (await showAll.isVisible()) await showAll.click();
  const text = await panelText(page, "Язык интерфейса");
  const leftovers = ENGLISH.filter((phrase) => text.includes(phrase));
  check("no English panel texts in Russian", leftovers.length === 0, leftovers.join(", "));
  const latin = [...new Set(text.match(/\b[A-Za-z][A-Za-z']{2,}\b/g) ?? [])].filter((word) => !NAMES.has(word));
  console.log(`info Latin words in the Russian panel (ids, paths, texts from bb): ${latin.join(" ")}`);
  check("Russian buttons fit", (await overflowing(page)).length === 0, (await overflowing(page)).join(", "));
  await page.screenshot({ path: `${home}/.fk-e2e/panel-ru.png`, fullPage: true });
  for (const width of [900, 600, 400]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const out = await overflowing(page);
    check(`Russian buttons fit at ${width} px`, out.length === 0, out.join(", "));
    await page.screenshot({ path: `${home}/.fk-e2e/panel-ru-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("group", { name: "Язык интерфейса" }).getByRole("button", { name: "EN" }).click();
  check("switch back to English", await page.getByRole("button", { name: "Sync now" }).waitFor({ timeout: 10_000 }).then(() => true, () => false));

  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("panel smoke", false, String(error).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(failures.length === 0 ? 0 : 1);
