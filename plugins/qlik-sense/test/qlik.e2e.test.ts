// End-to-end tests of the host side against a local Qlik Core engine.
// `npm run test:e2e` starts the engine with test/engine.sh and passes QLIK_TEST_ENGINE.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Catalog, ToolInput } from "../contract";
import { QlikService } from "../src/host/service";
import { sheetLink } from "../src/shared/links";
import { startMockProxy, type MockProxy } from "./helpers/mock-proxy";
import { seedApp, type Seed } from "./helpers/seed";

const ENGINE = process.env.QLIK_TEST_ENGINE;
if (!ENGINE) throw new Error("Set QLIK_TEST_ENGINE=ws://127.0.0.1:PORT (npm run test:e2e does it)");

const dataRows = (text: string) => text.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---")).slice(1);
const tempDir = () => mkdtemp(join(tmpdir(), "qlik-sense-e2e-"));

let seed: Seed;
beforeAll(async () => {
  seed = await seedApp(ENGINE);
});

function catalogFor(seed: Seed): Catalog {
  return {
    apps: [
      {
        id: seed.app,
        name: "Sales test",
        stream: null,
        note: "Revenue by region and channel",
        sheets: [{ id: seed.sheet, title: "Sales", note: "monthly revenue" }],
      },
    ],
  };
}

async function directService(fullScanLimit?: number) {
  const service = new QlikService({ dataDir: await tempDir(), engineUrl: ENGINE!, fullScanLimit });
  await service.saveCatalog(catalogFor(seed));
  const call = async (input: ToolInput) => service.tool(input);
  const ok = async (input: ToolInput) => {
    const result = await call(input);
    expect(result.isError, result.text).toBe(false);
    return result.text;
  };
  return { service, call, ok };
}

describe("direct engine", () => {
  let s: Awaited<ReturnType<typeof directService>>;
  beforeAll(async () => {
    s = await directService();
  });
  afterAll(() => s.service.close());

  it("lists the enabled reports with notes", async () => {
    const text = await s.ok({ tool: "reports" });
    expect(text).toContain(`## Sales test [app: ${seed.app}]`);
    expect(text).toContain("Use for: Revenue by region and channel");
    expect(text).toContain(`- "Sales" [sheet: ${seed.sheet}] — monthly revenue.`);
  });

  it("marks recommended sheets", async () => {
    expect(await s.ok({ tool: "sheets" })).toMatch(/"Sales" \[sheet: .+\] — objects: 5; recommended: monthly revenue/);
  });

  it("describes sheet objects found by part of the title", async () => {
    const text = await s.ok({ tool: "sheet_objects", sheet: "sal" });
    expect(text).toContain(`table "Sales by region" [id: ${seed.table}] — dimensions: Region, Month; measures: Revenue, Orders; rows: 9`);
    expect(text).toContain(seed.pivot);
    expect(text).toContain(seed.kpi);
    expect(text).toContain(seed.nested);
    expect(text).toMatch(/listbox .*field: Region/);
  });

  it("names the sheets when one is missing", async () => {
    const result = await s.call({ tool: "sheet_objects", sheet: "Finance" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Sheet "Finance" was not found. Sheets: Sales/);
  });

  it("lists fields and master items", async () => {
    const text = await s.ok({ tool: "fields" });
    expect(text).toMatch(/- Region — 5 values/);
    expect(text).toMatch(/- Revenue — Sum\(Amount\)/);
    expect(text).toMatch(/- Sales channel — Channel/);
  });

  it("reads a table without filters, with totals", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table });
    expect(text).toMatch(/Filters: none/);
    expect(text).toMatch(/Rows: 9/);
    expect(text).toMatch(/\| Region \| Month \| Revenue \| Orders \|/);
    expect(dataRows(text)).toHaveLength(9);
    expect(text).toMatch(/Totals: Revenue = \d+; Orders = 16/);
  });

  it("filters by one value, ignoring case", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table, filters: { Region: "north" } });
    expect(text).toMatch(/Filters: Region = North/);
    const rows = dataRows(text);
    expect(rows).toHaveLength(2);
    expect(rows.every((line) => line.startsWith("| North |"))).toBe(true);
  });

  it("filters by a list and by two fields", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table, filters: { Region: ["North", "East"], Month: "2026-10" } });
    expect(dataRows(text)).toHaveLength(2);
    expect(text).toMatch(/Month = 2026-10/);
  });

  it("does not keep filters from earlier calls", async () => {
    expect(await s.ok({ tool: "get_data", object: seed.table })).toMatch(/Rows: 9/);
  });

  it("suggests similar values for a miss", async () => {
    const result = await s.call({ tool: "get_data", object: seed.table, filters: { Region: "Nort" } });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has no value Nort. Similar: North/);
  });

  it("reports a missing field", async () => {
    const result = await s.call({ tool: "get_data", object: seed.table, filters: { City: "North" } });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Field "City" was not found/);
  });

  it("accepts a Qlik search string", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table, filters: { Region: "*ort*" } });
    expect(text).toMatch(/Region = North/);
    expect(dataRows(text)).toHaveLength(2);
  });

  it("filters a date range", async () => {
    const text = await s.ok({ tool: "query", dimensions: ["Date"], measures: ["Sum(Amount)"], filters: { Date: ">=01.10.2026<=03.10.2026" } });
    expect(dataRows(text)).toHaveLength(3);
  });

  it("reads a pivot as a flat table", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.pivot });
    expect(text).toMatch(/\| Region \| Channel \| Revenue \|/);
    expect(dataRows(text)).toHaveLength(9);
  });

  it("reads a KPI", async () => {
    expect(dataRows(await s.ok({ tool: "get_data", object: seed.kpi, filters: { Channel: "Online" } }))).toHaveLength(1);
  });

  it("points from a container to its nested objects", async () => {
    const result = await s.call({ tool: "get_data", object: seed.container });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(seed.nested);
    expect(dataRows(await s.ok({ tool: "get_data", object: seed.nested }))).toHaveLength(2);
  });

  it("reports a missing object", async () => {
    const result = await s.call({ tool: "get_data", object: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Object nope was not found/);
  });

  it("calculates a breakdown on master items, descending", async () => {
    const text = await s.ok({ tool: "query", dimensions: ["Sales channel"], measures: ["Revenue"], rawNumbers: true });
    const values = dataRows(text).map((line) => Number(line.split("|")[2]));
    expect(values).toHaveLength(2);
    expect(values[0]!).toBeGreaterThanOrEqual(values[1]!);
  });

  it("caps rows", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table, maxRows: 3 });
    expect(text).toMatch(/Rows: 9, showing the first 3/);
    expect(dataRows(text)).toHaveLength(3);
  });

  it("shows field values under filters", async () => {
    const text = await s.ok({ tool: "field_values", field: "Region", filters: { Channel: "Online" } });
    expect(text).toMatch(/5 values, 4 possible with these filters/);
    expect(text).toMatch(/- Central \[excluded\]/);
    const searched = await s.ok({ tool: "field_values", field: "Region", search: "sou" });
    expect(searched).toMatch(/- South/);
    expect(searched).not.toMatch(/North/);
  });

  it("warns when Qlik drops incompatible filters", async () => {
    const text = await s.ok({ tool: "get_data", object: seed.table, filters: { Region: "Central", Channel: "Online" } });
    expect(text).toMatch(/Warning: Qlik dropped the filters (Region|Channel)/);
  });

  it("refuses apps that are not ticked", async () => {
    await s.service.saveCatalog({ apps: [{ id: "other-app", name: "Other", stream: null, note: "", sheets: [] }] });
    const result = await s.call({ tool: "get_data", app: seed.app, object: seed.table });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is not enabled for agents/);
    await s.service.saveCatalog(catalogFor(seed));
  });
});

describe("large field: values are looked up by search", () => {
  it("selects exact values and reports a miss", async () => {
    const s = await directService(2);
    expect(dataRows(await s.ok({ tool: "get_data", object: seed.table, filters: { Region: ["North", "West"] } }))).toHaveLength(4);
    expect((await s.call({ tool: "get_data", object: seed.table, filters: { Region: "Nowhere" } })).isError).toBe(true);
    s.service.close();
  });
});

describe("through a proxy with forms sign-in", () => {
  let proxy: MockProxy;
  let service: QlikService;
  const user = "CORP\\tester";

  beforeAll(async () => {
    proxy = await startMockProxy({ engineUrl: ENGINE!, user, password: "secret" });
    service = new QlikService({ dataDir: await tempDir() });
    await service.saveConnection({ url: proxy.url, user, password: "secret" });
    await service.saveCatalog(catalogFor(seed));
  });
  afterAll(() => {
    service.close();
    proxy.close();
  });

  it("checks the sign-in and counts apps", async () => {
    const check = await service.checkSignIn(false);
    expect(check.ok, check.message).toBe(true);
    expect(check.message).toMatch(/^Signed in\. \d+ apps? available/);
    expect((await service.status()).lastCheck).toMatchObject({ ok: true, apps: check.apps });
  });

  it("signs in by itself and reads data", async () => {
    const before = proxy.stats.logins;
    const sheets = await service.tool({ tool: "sheets" });
    expect(sheets.text).toContain(sheetLink(`${proxy.url}/`, seed.app, seed.sheet));
    expect(dataRows((await service.tool({ tool: "get_data", object: seed.table })).text)).toHaveLength(9);
    expect(proxy.stats.logins - before).toBeLessThanOrEqual(1);
  });

  it("signs in again when the session expires", async () => {
    const before = proxy.stats.logins;
    await proxy.expire();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await service.tool({ tool: "get_data", object: seed.table, filters: { Region: "East" } });
    expect(dataRows(result.text), result.text).toHaveLength(2);
    expect(proxy.stats.logins - before).toBe(1);
  });

  it("lists apps and sheets for the catalog, with links", async () => {
    expect((await service.listApps()).some((app) => app.id === seed.app)).toBe(true);
    const sheets = await service.listSheets(seed.app);
    expect(sheets[0]).toMatchObject({ id: seed.sheet, title: "Sales", link: sheetLink(`${proxy.url}/`, seed.app, seed.sheet) });
  });

  it("checks a pasted link", async () => {
    const found = await service.checkLink(sheetLink(`${proxy.url}/`, seed.app, seed.sheet));
    expect(found).toMatchObject({ status: "ok", app: { id: seed.app }, sheet: { id: seed.sheet, title: "Sales" } });

    const denied = await service.checkLink(`${proxy.url}/sense/app/00000000-0000-0000-0000-000000000000/overview`);
    expect(denied.status).toBe("no-access");
    if (denied.status === "no-access") {
      expect(denied).toMatchObject({ user: "CORP\\tester", appId: "00000000-0000-0000-0000-000000000000" });
    }

    expect(await service.checkLink("https://elsewhere.example/sense/app/x/overview")).toMatchObject({ status: "invalid", reason: "other-site" });
    expect(await service.checkLink("hello")).toEqual({ status: "invalid", reason: "not-a-link" });
  });
});
