// Builds a test app inside the local Qlik Core engine: data, master items, and a
// sheet with a table, a pivot, a KPI, a filter pane and a container.
import { Connection, type EngineValue } from "../../src/host/qlik/engine";

export interface Seed {
  app: string;
  sheet: string;
  table: string;
  pivot: string;
  kpi: string;
  nested: string;
  filterpane: string;
  container: string;
  rows: number;
}

export async function seedApp(engine: string): Promise<Seed> {
  const c = await Connection.open(`${engine}/app/engineData/identity/seed`, {});
  const ret = async (handle: number, method: string, params: Record<string, unknown>): Promise<EngineValue> =>
    (await c.call(handle, method, params)).qReturn;

  const { qAppId } = await c.call(-1, "CreateApp", { qAppName: `bb-qlik-sense-test-${Date.now()}` });
  const doc = (await ret(-1, "OpenDoc", { qDocName: qAppId })).qHandle;

  const regions = ["North", "South", "East", "West"];
  const channels = ["Online", "Store"];
  const rows: string[] = [];
  let n = 0;
  for (const region of regions)
    for (const channel of channels)
      for (let month = 9; month <= 10; month++) rows.push(`${region}, 2026-${String(month).padStart(2, "0")}, ${channel}, ${((++n * 37) % 500) + 100}, ${n}`);

  await c.call(doc, "SetScript", {
    qScript: `SET DateFormat='DD.MM.YYYY';
Sales:
LOAD *, Date(MakeDate(2026,9,30) + Order) as Date INLINE [
Region, Month, Channel, Amount, Order
${rows.join("\n")}
];
Warehouses:
LOAD Region, 'Warehouse ' & Region as Warehouse INLINE [
Region
North
East
Central
];`,
  });
  const reload = await c.call(doc, "DoReload", {});
  if (!reload.qReturn) throw new Error("reload failed");

  await c.call(doc, "CreateMeasure", {
    qProp: { qInfo: { qType: "measure" }, qMeasure: { qLabel: "Revenue", qDef: "Sum(Amount)" }, qMetaDef: { title: "Revenue" } },
  });
  await c.call(doc, "CreateDimension", {
    qProp: {
      qInfo: { qType: "dimension" },
      qDim: { qGrouping: "N", qFieldDefs: ["Channel"], qFieldLabels: ["Sales channel"] },
      qMetaDef: { title: "Sales channel" },
    },
  });

  const sheet = (
    await ret(doc, "CreateObject", {
      qProp: { qInfo: { qType: "sheet" }, qMetaDef: { title: "Sales", description: "Test sheet" }, rank: 0, cells: [], qChildListDef: { qData: { title: "/title" } } },
    })
  ).qHandle;
  const child = async (handle: number, prop: unknown): Promise<string> => (await ret(handle, "CreateChild", { qProp: prop })).qGenericId;
  const dim = (field: string) => ({ qDef: { qFieldDefs: [field] } });
  const measure = (expr: string, label: string) => ({ qDef: { qDef: expr, qLabel: label } });

  const table = await child(sheet, {
    qInfo: { qType: "table" },
    visualization: "table",
    title: "Sales by region",
    qHyperCubeDef: { qDimensions: [dim("Region"), dim("Month")], qMeasures: [measure("Sum(Amount)", "Revenue"), measure("Count(Order)", "Orders")], qColumnOrder: [2, 0, 1, 3] },
  });
  const pivot = await child(sheet, {
    qInfo: { qType: "pivot-table" },
    visualization: "pivot-table",
    title: "Pivot by channel",
    qHyperCubeDef: { qMode: "P", qNoOfLeftDims: 1, qAlwaysFullyExpanded: true, qDimensions: [dim("Region"), dim("Channel")], qMeasures: [measure("Sum(Amount)", "Revenue")] },
  });
  const kpi = await child(sheet, {
    qInfo: { qType: "kpi" },
    visualization: "kpi",
    title: "Total revenue",
    qHyperCubeDef: { qMeasures: [measure("Sum(Amount)", "Revenue")] },
  });
  const filterpane = (await ret(sheet, "CreateChild", { qProp: { qInfo: { qType: "filterpane" }, visualization: "filterpane", title: "" } })).qHandle;
  for (const field of ["Region", "Month"]) {
    await child(filterpane, { qInfo: { qType: "listbox" }, visualization: "listbox", qListObjectDef: { qDef: { qFieldDefs: [field] } } });
  }
  const container = (await ret(sheet, "CreateChild", { qProp: { qInfo: { qType: "container" }, visualization: "container", title: "Tabs" } })).qHandle;
  const nested = await child(container, {
    qInfo: { qType: "barchart" },
    visualization: "barchart",
    title: "By channel",
    qHyperCubeDef: { qDimensions: [dim("Channel")], qMeasures: [measure("Sum(Amount)", "Revenue")] },
  });
  const ids = {
    app: qAppId as string,
    table,
    pivot,
    kpi,
    nested,
    sheet: (await c.call(sheet, "GetLayout")).qLayout.qInfo.qId as string,
    filterpane: (await c.call(filterpane, "GetLayout")).qLayout.qInfo.qId as string,
    container: (await c.call(container, "GetLayout")).qLayout.qInfo.qId as string,
  };
  await c.call(sheet, "SetProperties", {
    qProp: {
      ...(await c.call(sheet, "GetProperties")).qProp,
      cells: (["table", "pivot", "kpi", "filterpane", "container"] as const).map((key) => ({ name: ids[key], type: key })),
    },
  });
  await c.call(doc, "DoSave", {});
  c.close();
  return { ...ids, rows: rows.length };
}
