// Panel check on a throwaway bb (never your own): both languages, several
// widths, the paste flow, nothing pushed off the edge, no console errors.
//   node panel-smoke.mjs <bb url> <shots dir>
// Needs playwright-core and a Chromium (PW_CHROME, default: Playwright's cache).
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [base, shots] = process.argv.slice(2);
if (!base || !shots) throw new Error("usage: node panel-smoke.mjs <bb url> <shots dir>");
await mkdir(shots, { recursive: true });
const executablePath = process.env.PW_CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const failures = [];
const consoleErrors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: /Skip setup/i });
  await skip.waitFor({ timeout: 20_000 }).then(() => skip.click(), () => undefined);

  const open = async (lang) => {
    await page.evaluate((value) => localStorage.setItem("xminor-plugins.lang", value), lang);
    await page.goto(`${base}/plugins/mcp-catalog/mcp`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("group", { name: /Interface language|Язык интерфейса/ }).waitFor({ timeout: 30_000 });
      await page.locator("[data-server]").first().waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({ path: join(shots, `stuck-${lang}.png`) });
      throw error;
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);
  };

  const offscreen = () =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll("[data-mcp-page] button, [data-mcp-page] a, [data-mcp-page] input, [data-mcp-page] textarea, [data-mcp-page] [role=switch]")]
        .filter((element) => element.offsetParent !== null)
        .map((element) => ({ text: (element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 40), right: element.getBoundingClientRect().right }))
        .filter((item) => item.right > width + 1);
    });

  for (const lang of ["en", "ru"]) {
    await open(lang);
    const rows = await page.locator("[data-server]").count();
    if (rows < 2) failures.push(`${lang}: ${rows} server rows`);
    const catalog = await page.locator("[data-catalog-item]").count();
    if (catalog !== 3) failures.push(`${lang}: ${catalog} catalog items`);
    const connectedBadges = await page.locator("[data-catalog-item]").filter({ hasText: lang === "en" ? "Connected" : "Подключён" }).count();
    if (connectedBadges !== 2) failures.push(`${lang}: ${connectedBadges} connected badges (want wiki and tracker)`);
    const href = await page.locator('[data-catalog-item="gitlab"] a').getAttribute("href");
    if (href !== "https://mcp.example.com/dashboard?template=gitlab") failures.push(`${lang}: platform link ${href}`);
    const masked = await page.locator("#mcp-paste").evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-text-security"));
    if (masked !== "disc") failures.push(`${lang}: paste field not masked (${masked})`);
    if (lang === "ru") {
      const main = await page.locator("[data-mcp-page]").innerText();
      for (const word of ["Your MCP servers", "Connect servers", "Catalog", "Works", "Check all", "Create on the platform"]) {
        if (main.includes(word)) failures.push(`ru: English text left: ${word}`);
      }
    }
    for (const width of [1280, 900, 600, 400]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const out = await offscreen();
      if (out.length > 0) failures.push(`${lang} ${width}px: off the edge: ${JSON.stringify(out)}`);
      await page.screenshot({ path: join(shots, `${lang}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  // The paste flow through the panel: a server whose token the stub does not know.
  await open("en");
  await page.locator("#mcp-paste").fill(JSON.stringify({ mcp: { corp_gitlab_00aa11bb: { type: "remote", url: "http://127.0.0.1:7900/u/1/gitlab/mcp", headers: { Authorization: "Bearer tok-synthetic-unknown-333" } } } }));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // "Updated" on a second run, when the server is already there.
  await page.getByText(/^(Added|Updated): corp_gitlab_00aa11bb\.$/).waitFor({ timeout: 20_000 });
  if ((await page.locator("#mcp-paste").inputValue()) !== "") failures.push("the paste field kept the text after Add");
  await page.locator('[data-server="corp_gitlab_00aa11bb"]').getByText("Token not accepted").waitFor({ timeout: 30_000 });
  if ((await page.content()).includes("tok-synthetic-unknown-333")) failures.push("the token is on the page after Add");
  await page.screenshot({ path: join(shots, "en-after-add.png"), fullPage: true });

  // Switching off from the panel.
  await page.getByRole("switch", { name: "Use corp_gitlab_00aa11bb in new threads" }).click();
  await page.waitForFunction(() => document.querySelector('[data-server="corp_gitlab_00aa11bb"] [role=switch]')?.getAttribute("aria-checked") === "false", null, { timeout: 20_000 });

  // Removal from the panel, which also leaves the stand as the next run expects it.
  const row = page.locator('[data-server="corp_gitlab_00aa11bb"]');
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await row.getByRole("button", { name: "Yes, remove", exact: true }).click();
  await row.waitFor({ state: "detached", timeout: 20_000 });
} finally {
  await browser.close();
}

const relevantErrors = consoleErrors.filter((text) => /mcp-catalog|plugins\/mcp/i.test(text));
console.log(JSON.stringify({ failures, consoleErrors: relevantErrors, allConsoleErrors: consoleErrors.length }, null, 2));
process.exit(failures.length > 0 || relevantErrors.length > 0 ? 1 : 0);
