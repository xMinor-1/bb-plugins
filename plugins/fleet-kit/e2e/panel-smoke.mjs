// Clicks through the Fleet Kit panel in a headless browser inside the e2e
// container: renders, Sync now, remove a secret and enter it again through the
// form. Prints one line per check; exits 1 when any check fails.
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

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${base}/plugins/fleet-kit/status`, { waitUntil: "networkidle" });
  // A fresh bb opens its first-run setup instead of the requested page.
  const skip = page.getByText("Skip setup");
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
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("panel smoke", false, String(error).slice(0, 400));
} finally {
  await browser.close();
}
process.exit(failures.length === 0 ? 0 : 1);
