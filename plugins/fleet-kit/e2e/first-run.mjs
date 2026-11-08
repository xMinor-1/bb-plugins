// The First run page on a fresh bb, in a headless browser inside the e2e
// container: one sidebar entry, the page opening on launch once per launch
// while steps are left, the branch preview and Install, the install queue one
// plugin at a time, the shared sign-in handed to a plugin in its login format,
// the planned plugin as one line, the build's sidebar set once. Prints one line
// per check; exits 1 when any check fails.
//
// Needs a bb that has had no build yet: a new container from e2e/run.sh, not
// the one scenario.sh ran in. Inside it, with playwright-core in ~/pw and
// Chromium from apt (the README's panel-smoke steps):
//   node ~/pw/first-run.mjs
// The script installs Fleet Kit and points it at ~/build/first-run.json
// (written by inside-setup.sh).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:38886";
const home = process.env.HOME;
const manifest = `${home}/build/first-run.json`;
const LOGIN = "jdoe@corp.example";
const PASSWORD = "s3cret-pass-e2e";
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const sh = (command) => execFileSync("bash", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (command) => JSON.parse(sh(command));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const installed = () => json("bb plugin list --json").plugins?.map?.((plugin) => plugin.id) ?? json("bb plugin list --json").map((plugin) => plugin.id);
const setup = () => json("bb fleet-kit setup --json");
const ui = (key) => json(`bb settings ui get ${key} --json`);
const uiValue = (key) => {
  const answer = ui(key);
  return answer !== null && typeof answer === "object" && !Array.isArray(answer) && "value" in answer ? answer.value : answer;
};
async function until(what, test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await test()) return true;
    } catch {
      // not yet
    }
    if (Date.now() > end) return false;
    await sleep(500);
  }
}
const path = (page) => new URL(page.url()).pathname;
/** Names of the visible buttons and links: aria-label, else text. `rail`: only bb's navigation rail on the left edge. */
const named = (page, rail = false) => page.evaluate((rail) => [...document.querySelectorAll("button, a[href], [role=menuitem]")]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!rail || r.left < 48); })
  .map((el) => (el.getAttribute("aria-label") || el.innerText || "").trim()).filter(Boolean), rail);
const NAV_HIDDEN = /^(Plugins|Skills|Automations)$/;
const REPORT = /report a bug/i;
/** The items of a sidebar menu: "More" in the rail, "More footer actions" in the footer. */
async function menuItems(page, button) {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  await sleep(600);
  const items = await page.evaluate(() => [...document.querySelectorAll("[role=menuitem]")].map((item) => item.innerText.trim()));
  await page.keyboard.press("Escape");
  await sleep(300);
  return items;
}
const SETUP_PATH = "/plugins/fleet-kit/status/setup";

// Buttons whose text overflows them, or that stick out past their panel or the window.
async function overflowing(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("div.max-w-3xl button")]
      .filter((button) => {
        const panel = button.closest("div.max-w-3xl");
        const edge = Math.min(window.innerWidth, panel.getBoundingClientRect().right);
        return button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1
          || button.getBoundingClientRect().right > edge + 1;
      })
      .map((button) => button.innerText.trim() || button.getAttribute("aria-label") || "?"),
  );
}

if (installed().includes("fleet-kit")) {
  console.log("FAIL needs a bb without Fleet Kit: start a new container with e2e/run.sh");
  process.exit(1);
}
const source = sh(`jq -r '.plugins[] | select(.id == "fleet-kit") | .source' ${manifest}`);
sh(`bb plugin install '${source}' --plugin fleet-kit --yes`);
sh("bb plugin config fleet-kit set allowDevSources true");

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const errors = [];
/** A new context is a new launch of the app: its own sessionStorage and localStorage. */
async function launch(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${path(page)}: ${message.text()}`);
  });
  return { context, page };
}
try {
  // bb's own first-run guide replaces the app shell (and with it the overlays); it is the server's state, so skip it once.
  {
    const { context, page } = await launch();
    await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
    const skip = page.getByText("Skip setup");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    // A page with the thread sidebar and its footer (Settings has its own list instead).
    await page.goto(`${base}/plugins/fleet-kit/status/sync`, { waitUntil: "networkidle" });
    await sleep(2500);
    // The control: before the build's sidebar, bb shows these, so their absence later means something.
    const rail = await named(page, true);
    const all = await named(page);
    check("control: before the build, the rail has Plugins, Skills, Automations", ["Plugins", "Skills", "Automations"].every((name) => rail.includes(name)), rail.join(" | "));
    check("control: before the build, Report a bug is in the footer", all.some((name) => REPORT.test(name)), all.filter((name) => name.length < 40).join(" | "));
    await context.close();
  }

  sh(`bb plugin config fleet-kit set manifestUrl file://${manifest}`);
  const synced = await until("first sync", () => setup().configured === true && installed().includes("fixture-acct"), 180_000);
  check("first sync installs the common plugin only", synced && !installed().includes("fixture-slow1") && !installed().includes("fixture-slow2"),
    `installed: ${installed().join(" ")}`);
  const wantedUi = JSON.parse(readFileSync(manifest, "utf8")).bb.ui;
  for (const [key, value] of Object.entries(wantedUi)) {
    check(`bb.ui: sidebar.${key} is the manifest's`, JSON.stringify(uiValue(`sidebar.${key}`)) === JSON.stringify(value), JSON.stringify(ui(`sidebar.${key}`)));
  }

  // A fresh launch on the new-thread screen opens First run.
  const a = await launch();
  await a.page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  const redirected = await until("redirect", () => path(a.page) === SETUP_PATH, 20_000);
  check("appOverlay mounts and opens First run from /", redirected, path(a.page));
  if (!redirected) {
    const mark = await a.page.evaluate(() => sessionStorage.getItem("fleet-kit.first-run-opened"));
    console.log(`info sessionStorage fleet-kit.first-run-opened: ${mark} (null: the overlay never ran)`);
  }
  // about:blank and / before the redirect: a replace keeps two entries, a push would make three.
  check("the redirect replaces the history entry", (await a.page.evaluate(() => history.length)) === 2, String(await a.page.evaluate(() => history.length)));

  // bb's navigation rail: one icon button per entry, named by aria-label.
  const rail = await a.page.evaluate(() => [...document.querySelectorAll("button[aria-label]")]
    .filter((button) => button.getBoundingClientRect().left < 48 && button.getBoundingClientRect().width > 0)
    .map((button) => button.getAttribute("aria-label")));
  // While steps are left the entry's name carries the badge: "Fleet Kit, 2 setup steps left".
  check("sidebar: one Fleet Kit entry", rail.filter((name) => /^Fleet Kit\b/.test(name)).length === 1, rail.join(" | "));
  check("sidebar: no First run entry", !rail.some((name) => /first run/i.test(name)), rail.join(" | "));
  check("sidebar: no Plugins, Skills, Automations in the rail", !rail.some((name) => NAV_HIDDEN.test(name)), rail.join(" | "));
  check("footer: Report a bug not shown", !(await named(a.page)).some((name) => REPORT.test(name)));
  const footerMore = await menuItems(a.page, "More footer actions").catch(() => []);
  check("footer: Report a bug under More footer actions", footerMore.some((name) => REPORT.test(name)), footerMore.join(" | "));
  const navMore = await menuItems(a.page, "More").catch(() => []);
  check("rail: Plugins, Skills, Automations under More", ["Plugins", "Skills", "Automations"].every((name) => navMore.includes(name)), navMore.join(" | "));
  check("First run tab selected", (await a.page.locator('[data-tab="setup"]').getAttribute("aria-selected")) === "true");

  // The same launch, back on /: left there (a reload keeps the session).
  await a.page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await sleep(10_000);
  check("same session: / is left alone", path(a.page) === "/", path(a.page));

  // Another launch opens it again while steps are left.
  const b = await launch();
  await b.page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  check("new launch: / opens First run again", await until("redirect", () => path(b.page) === SETUP_PATH, 20_000), path(b.page));
  await b.context.close();

  // A launch that starts on another page is not taken away from it, nor later from /.
  const d = await launch();
  await d.page.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
  await sleep(10_000);
  check("new launch on /settings: stays", path(d.page).startsWith("/settings"), path(d.page));
  await d.page.getByRole("button", { name: "Home", exact: true }).click();
  await until("home", () => path(d.page) === "/", 5_000);
  await sleep(10_000);
  check("then Home in the sidebar (in-app to /): stays", path(d.page) === "/", path(d.page));
  await d.context.close();

  // The First run page.
  const page = a.page;
  await page.goto(`${base}${SETUP_PATH}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-branches]").waitFor({ timeout: 30_000 });
  const planned = page.locator("[data-planned]");
  check("planned plugin: one line", (await planned.count()) === 1 && (await planned.getAttribute("data-planned")) === "someday"
    && /Coming in a later version: Someday plugin/.test(await planned.innerText()), await planned.innerText().catch(() => ""));
  check("planned plugin: no switch and no step", (await page.locator('[data-plugin="someday"]').count()) === 0 && (await page.locator('[data-step="someday"]').count()) === 0);
  console.log(`info step slow-two before the branch: ${await page.locator('[data-step="slow-two"]').getAttribute("data-state").catch(() => "absent")}`);

  await page.locator('[data-branch="office"]').click();
  await sleep(500);
  check("branch click: previewed", (await page.locator("[data-branches]").getAttribute("data-selected")) === "office"
    && (await page.locator("[data-branches]").getAttribute("data-branches")) === "");
  check("branch click: Install button", await page.locator('[data-install-branch="office"]').isVisible());
  await sleep(4_000);
  check("branch click: nothing chosen or installed", setup().branches?.chosen == null && !installed().includes("fixture-slow1"),
    `chosen ${setup().branches?.chosen}, installed ${installed().join(" ")}`);

  await page.locator('[data-install-branch="office"]').click();
  check("Install: started", await page.locator('[data-branch-saved="started"]').waitFor({ timeout: 15_000 }).then(() => true, () => false));
  const first = await until("slow1 installing", () => page.locator('[data-install="fixture-slow1"][data-install-state="installing"]').isVisible(), 60_000);
  check("queue: Slow one installing", first);
  check("queue: Slow two queued", await page.locator('[data-install="fixture-slow2"][data-install-state="queued"]').isVisible());
  check("queue: one spinner", (await page.locator('[data-install-state="installing"]').count()) === 1);
  check("queue: card running", (await page.locator("[data-installs]").getAttribute("data-installs")) === "running");
  check("queue: install note shown", await page.locator("[data-installs]").getByText("About 20 seconds").first().isVisible());
  check("step of a queued plugin: queued", (await page.locator('[data-step="slow-two"]').getAttribute("data-state")) === "queued",
    await page.locator('[data-step="slow-two"]').getAttribute("data-state").catch(() => "absent"));
  const second = await until("slow2 installing", () => page.locator('[data-install="fixture-slow2"][data-install-state="installing"]').isVisible(), 120_000);
  check("queue: then Slow two installing, Slow one done", second && (await page.locator('[data-install="fixture-slow1"][data-install-state="done"]').isVisible()));
  check("step of the installing plugin: installing", (await page.locator('[data-step="slow-two"]').getAttribute("data-state")) === "installing",
    await page.locator('[data-step="slow-two"]').getAttribute("data-state").catch(() => "absent"));
  check("queue: card finished", await until("finished", async () => (await page.locator("[data-installs]").getAttribute("data-installs")) === "finished", 120_000));
  const doneIds = await page.locator('[data-install-state="done"]').evaluateAll((items) => items.map((item) => item.getAttribute("data-install")));
  check("queue: done in the manifest's order", JSON.stringify(doneIds) === JSON.stringify(["fixture-slow1", "fixture-slow2"]), doneIds.join(" "));
  const installs = setup().installs;
  check("setup_status installs: done[] and finishedAt", installs?.finishedAt != null && installs.current === null && installs.queue.length === 0
    && JSON.stringify(installs.done.map((item) => [item.id, item.ok])) === JSON.stringify([["fixture-slow1", true], ["fixture-slow2", true]])
    && typeof installs.averageSeconds === "number", JSON.stringify(installs).slice(0, 300));
  check("both slow plugins installed", installed().includes("fixture-slow1") && installed().includes("fixture-slow2"));
  check("branch chosen", setup().branches?.chosen === "office");

  // The shared sign-in: the window line first (done once the plugin is signed in), then the form.
  const windowLine = page.locator('[data-account-window="fixture-acct"]');
  check("account: window line", await windowLine.isVisible());
  const signIn = windowLine.getByRole("button", { name: "Sign in" });
  if (await signIn.isVisible()) {
    await signIn.click();
    check("account: window button calls the plugin with a hostId", await until("window", () => /hostId/.test(readFileSync(`${home}/.fk-e2e/account-window.log`, "utf8")), 10_000));
  } else check("account: window button shown", false, await windowLine.innerText());
  const form = page.locator("[data-account-form]");
  await form.locator('input[name="login"]').fill(LOGIN);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.getByRole("button", { name: "Save" }).click();
  check("account: plugin line done", await page.locator('[data-account-plugin="fixture-acct"][data-state="done"]').waitFor({ timeout: 60_000 }).then(() => true, () => false),
    await page.locator('[data-account-plugin="fixture-acct"]').getAttribute("data-state").catch(() => "absent"));
  const got = existsSync(`${home}/.fk-e2e/account.json`) ? JSON.parse(readFileSync(`${home}/.fk-e2e/account.json`, "utf8")) : {};
  check("account: the plugin got the login in its format", got.user === "CORP\\jdoe", JSON.stringify(got.user));
  check("account: the plugin got the password", got.passwordLength === PASSWORD.length, String(got.passwordLength));
  const calls = readFileSync(`${home}/.fk-e2e/account-calls.log`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check("account: called once, by fleet-kit", calls.length === 1 && calls[0].caller.kind === "plugin" && calls[0].caller.pluginId === "fleet-kit", JSON.stringify(calls));
  check("account: the password is not on the page", !(await page.content()).includes(PASSWORD));
  check("account: the password is in no Fleet Kit log", !sh(`grep -rl -- '${PASSWORD}' ~/.local/share ~/.bb ~/.config 2>/dev/null | grep -i log || true`));

  // The last step: a plugin without setupStatus, marked by hand.
  const slowStep = page.locator('[data-step="slow-two"]');
  const mark = slowStep.getByRole("button", { name: "Mark as done" });
  if (await mark.isVisible().catch(() => false)) await mark.click();
  check("plugin step marked done", await until("marked", async () => (await slowStep.getAttribute("data-state")) === "done", 15_000),
    await slowStep.getAttribute("data-state").catch(() => "absent"));
  check("all steps done", await until("complete", () => setup().complete === true, 30_000), JSON.stringify(setup().steps?.map((step) => [step.id, step.state])));

  for (const width of [400, 900, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(400);
    const out = await overflowing(page);
    check(`First run buttons fit at ${width} px`, out.length === 0, out.join(", "));
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Everything done: a new launch stays on /.
  const c = await launch();
  await c.page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await sleep(10_000);
  check("steps done: a new launch stays on /", path(c.page) === "/", path(c.page));
  await c.context.close();

  // bb.ui set once: the person's change stays through the next sync.
  const mine = ["fleet-kit/fleet-kit", "fixture-acct/none"];
  sh(`bb settings ui set sidebar.visiblePluginPanels '${JSON.stringify(mine)}'`);
  sh("bb fleet-kit sync >/dev/null 2>&1 || true");
  await sleep(2_000);
  check("bb.ui: a change by hand stays after a sync", JSON.stringify(uiValue("sidebar.visiblePluginPanels")) === JSON.stringify(mine),
    JSON.stringify(ui("sidebar.visiblePluginPanels")));

  await a.context.close();
  check("no console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
} catch (error) {
  check("first run", false, String(error).slice(0, 400));
  if (errors.length > 0) console.log(`info console errors: ${errors.slice(0, 5).join(" | ")}`);
} finally {
  await browser.close();
}
process.exit(failures.length === 0 ? 0 : 1);
