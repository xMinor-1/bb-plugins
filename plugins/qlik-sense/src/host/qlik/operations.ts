// Operations on a Qlik app: sheets, objects, fields, filters, data.
// Every call starts from clean selections: clear all → apply this call's filters → read.
import { AuthError, Connection, DisconnectError, EngineError, type EngineValue } from "./engine.js";
import type { QlikConfig, Session } from "./auth.js";

const LIST = "/qListObjectDef";
const CUBE = "/qHyperCubeDef";
const PAGE_CELLS = 10_000; // the engine's cell limit for one data page

const norm = (value: unknown) => String(value).trim().toLowerCase();
const isPattern = (value: string) => /^[<>=]/.test(value) || value.includes("*");

/** The pseudo-app that answers app-independent calls such as GetDocList. */
export const ENGINE_DATA = "engineData";

export function engineSocketUrl(config: QlikConfig, appId: string): string {
  const root = config.engineUrl?.replace(/\/+$/, "") ?? config.base!.replace(/^http/, "ws").replace(/\/$/, "");
  return `${root}/app/${encodeURIComponent(appId)}/identity/${encodeURIComponent(config.identity)}`;
}

export type Run<T> = (connection: Connection, doc: number | null) => Promise<T>;

export class QlikApp {
  #queue: Promise<unknown> = Promise.resolve();
  #connection: Connection | null = null;
  #doc: number | null = null;

  constructor(
    private readonly session: Session,
    readonly appId: string,
  ) {}

  /** Calls to one app run one at a time: selections are shared by the whole engine session. */
  run<T>(fn: Run<T>): Promise<T> {
    const next = this.#queue.then(() => this.#withReconnect(fn));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #withReconnect<T>(fn: Run<T>): Promise<T> {
    await this.#ensure();
    try {
      return await fn(this.#connection!, this.#doc);
    } catch (error) {
      if (!(error instanceof DisconnectError)) throw error;
      await this.#ensure();
      return fn(this.#connection!, this.#doc);
    }
  }

  async #ensure(): Promise<void> {
    if (this.#connection && !this.#connection.closed) return;
    const hadSession = this.session.hasSession;
    try {
      await this.#connect();
    } catch (error) {
      // An expired proxy session gets one fresh sign-in. A refused sign-in is never retried.
      const retryable = error instanceof AuthError || error instanceof DisconnectError;
      if (!hadSession || !this.session.usesForms || !retryable) throw error;
      this.session.invalidate();
      await this.#connect();
    }
  }

  async #connect(): Promise<void> {
    try {
      await this.session.ensure();
      this.#connection = await Connection.open(engineSocketUrl(this.session.config, this.appId), this.session.headers());
      this.#doc = this.appId === ENGINE_DATA ? null : await openDoc(this.#connection, this.appId);
    } catch (error) {
      this.#connection?.close();
      this.#connection = null;
      throw error;
    }
  }

  close(): void {
    this.#connection?.close();
  }
}

/** Thrown when the account cannot open an app — the access hint keys off it. */
export class NoAccessError extends EngineError {}

async function openDoc(c: Connection, appId: string): Promise<number> {
  try {
    return (await c.call(-1, "OpenDoc", { qDocName: appId })).qReturn.qHandle;
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    // 1002: the app is already open in this engine session.
    if (error.code === 1002) return (await c.call(-1, "GetActiveDoc")).qReturn.qHandle;
    if (error.code === 1003 || error.code === 403 || error.code === 5) {
      throw new NoAccessError(`App ${appId} was not found or this account has no access to it`, error.code);
    }
    throw error;
  }
}

const layoutOf = async (c: Connection, handle: number): Promise<EngineValue> => (await c.call(handle, "GetLayout")).qLayout;

async function getObject(c: Connection, doc: number, id: string): Promise<number> {
  const handle = (await c.call(doc, "GetObject", { qId: id })).qReturn?.qHandle;
  if (!handle) throw new EngineError(`Object ${id} was not found`);
  return handle;
}

async function withSessionObject<T>(c: Connection, doc: number, props: unknown, fn: (handle: number) => Promise<T>): Promise<T> {
  const created = (await c.call(doc, "CreateSessionObject", { qProp: props })).qReturn;
  try {
    return await fn(created.qHandle);
  } finally {
    await c.call(doc, "DestroySessionObject", { qId: created.qGenericId }).catch(() => {});
  }
}

const listbox = (field: string) => ({
  qInfo: { qType: "agent-listbox" },
  qListObjectDef: {
    qDef: { qFieldDefs: [field], qSortCriterias: [{ qSortByState: 1, qSortByNumeric: 1, qSortByAscii: 1, qSortByLoadOrder: 1 }] },
    qInitialDataFetch: [],
  },
});

async function listData(c: Connection, handle: number, top: number, height: number): Promise<EngineValue[]> {
  const result = await c.call(handle, "GetListObjectData", { qPath: LIST, qPages: [{ qTop: top, qLeft: 0, qWidth: 1, qHeight: height }] });
  return (result.qDataPages[0]?.qMatrix ?? []).map((row: EngineValue[]) => row[0]);
}

const fieldMissing = (field: string) => new EngineError(`Field "${field}" was not found. List fields with qlik_list_fields`);

// ---------- Apps, sheets, objects ----------

export interface AppInfo {
  id: string;
  name: string;
  stream: string | null;
  reloaded: string | null;
}

export async function listApps(c: Connection): Promise<AppInfo[]> {
  const { qDocList } = await c.call(-1, "GetDocList");
  return (qDocList as EngineValue[]).map((doc) => ({
    id: doc.qDocId,
    name: doc.qTitle || doc.qDocName,
    stream: doc.qMeta?.stream?.name ?? null,
    reloaded: doc.qLastReloadTime ?? null,
  }));
}

export async function appTitle(c: Connection, doc: number): Promise<string> {
  const layout = (await c.call(doc, "GetAppLayout")).qLayout;
  return layout?.qTitle ?? "";
}

export interface SheetInfo {
  id: string;
  title: string;
  description: string;
  published: boolean | null;
  objects: number;
  rank: number;
}

export async function listSheets(c: Connection, doc: number): Promise<SheetInfo[]> {
  return withSessionObject(
    c,
    doc,
    { qInfo: { qType: "agent-sheets" }, qAppObjectListDef: { qType: "sheet", qData: { rank: "/rank", cells: "/cells" } } },
    async (handle) => {
      const items: EngineValue[] = (await layoutOf(c, handle)).qAppObjectList.qItems;
      return items
        .map((sheet) => ({
          id: sheet.qInfo.qId,
          title: sheet.qMeta?.title ?? "",
          description: sheet.qMeta?.description ?? "",
          published: sheet.qMeta?.published ?? null,
          objects: sheet.qData?.cells?.length ?? 0,
          rank: Number(sheet.qData?.rank) || 0,
        }))
        .sort((a, b) => a.rank - b.rank);
    },
  );
}

export async function resolveSheet(c: Connection, doc: number, ref: string): Promise<SheetInfo> {
  const sheets = await listSheets(c, doc);
  const wanted = norm(ref);
  const sheet =
    sheets.find((s) => s.id === ref) ?? sheets.find((s) => norm(s.title) === wanted) ?? sheets.find((s) => norm(s.title).includes(wanted));
  if (!sheet) throw new EngineError(`Sheet "${ref}" was not found. Sheets: ${sheets.map((s) => s.title).join("; ")}`);
  return sheet;
}

export interface ObjectInfo {
  id: string;
  type: string;
  title: string;
  dimensions?: string[];
  measures?: string[];
  rows?: number;
  field?: string;
  children?: ObjectInfo[];
}

async function describe(c: Connection, doc: number, id: string, depth: number): Promise<ObjectInfo> {
  const handle = await getObject(c, doc, id);
  const layout = await layoutOf(c, handle);
  const title = typeof layout.title === "string" ? layout.title : "";
  const out: ObjectInfo = { id, type: layout.visualization ?? layout.qInfo?.qType ?? "?", title: title || layout.qMeta?.title || "" };
  const cube = layout.qHyperCube;
  if (cube) {
    out.dimensions = cube.qDimensionInfo.map((d: EngineValue) => d.qFallbackTitle);
    out.measures = cube.qMeasureInfo.map((m: EngineValue) => m.qFallbackTitle);
    out.rows = cube.qSize?.qcy ?? 0;
  }
  if (layout.qListObject) out.field = layout.qListObject.qDimensionInfo.qFallbackTitle;
  if (depth < 2) {
    const { qInfos } = await c.call(handle, "GetChildInfos");
    if (qInfos.length) out.children = await Promise.all(qInfos.map((info: EngineValue) => describe(c, doc, info.qId, depth + 1)));
  }
  return out;
}

export async function sheetObjects(c: Connection, doc: number, sheetRef: string): Promise<{ sheet: SheetInfo; objects: ObjectInfo[] }> {
  const sheet = await resolveSheet(c, doc, sheetRef);
  const handle = await getObject(c, doc, sheet.id);
  const { qInfos } = await c.call(handle, "GetChildInfos");
  const objects = await Promise.all(qInfos.map((info: EngineValue) => describe(c, doc, info.qId, 1)));
  return { sheet, objects };
}

// ---------- Fields and master items ----------

export interface FieldList {
  fields: { name: string; cardinal: number | null }[];
  dimensions: { id: string; title: string; field: string }[];
  measures: { id: string; title: string; expr: string }[];
}

export async function listFields(c: Connection, doc: number): Promise<FieldList> {
  return withSessionObject(
    c,
    doc,
    {
      qInfo: { qType: "agent-fields" },
      qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowDerivedFields: false },
      qDimensionListDef: { qType: "dimension", qData: { title: "/qMetaDef/title", dim: "/qDim" } },
      qMeasureListDef: { qType: "measure", qData: { title: "/qMetaDef/title", expr: "/qMeasure/qDef" } },
    },
    async (handle) => {
      const layout = await layoutOf(c, handle);
      return {
        fields: (layout.qFieldList?.qItems ?? []).map((f: EngineValue) => ({ name: f.qName, cardinal: f.qCardinal ?? null })),
        dimensions: (layout.qDimensionList?.qItems ?? []).map((d: EngineValue) => ({
          id: d.qInfo.qId,
          title: d.qMeta?.title ?? d.qData?.title,
          field: d.qData?.dim?.qFieldDefs?.join(" / ") ?? "",
        })),
        measures: (layout.qMeasureList?.qItems ?? []).map((m: EngineValue) => ({
          id: m.qInfo.qId,
          title: m.qMeta?.title ?? m.qData?.title,
          expr: m.qData?.expr ?? "",
        })),
      };
    },
  );
}

// ---------- Filters ----------

export type Filters = Record<string, string | number | (string | number)[]>;

async function findElems(c: Connection, handle: number, field: string, values: string[], fullScanLimit: number): Promise<number[]> {
  const { qListObject } = await layoutOf(c, handle);
  if (qListObject.qDimensionInfo.qError) throw fieldMissing(field);
  const total: number = qListObject.qSize.qcy;
  const found = new Map<string, number>();

  if (total <= fullScanLimit) {
    const page = Math.min(PAGE_CELLS, Math.max(total, 1));
    for (let top = 0; top < total; top += page) {
      for (const cell of await listData(c, handle, top, page)) if (cell.qElemNumber >= 0) found.set(norm(cell.qText), cell.qElemNumber);
    }
  } else {
    // A field with hundreds of thousands of values: look each value up with the engine search.
    for (const value of values) {
      await c.call(handle, "SearchListObjectFor", { qPath: LIST, qMatch: value });
      for (const cell of await listData(c, handle, 0, 200)) {
        if (cell.qElemNumber >= 0 && !found.has(norm(cell.qText))) found.set(norm(cell.qText), cell.qElemNumber);
      }
      await c.call(handle, "AbortListObjectSearch", { qPath: LIST });
    }
  }

  const missing = values.filter((value) => !found.has(norm(value)));
  if (missing.length) {
    await c.call(handle, "SearchListObjectFor", { qPath: LIST, qMatch: missing[0] });
    const similar = (await listData(c, handle, 0, 10)).map((cell) => cell.qText);
    await c.call(handle, "AbortListObjectSearch", { qPath: LIST });
    throw new EngineError(
      `Field "${field}" has no value ${missing.join(", ")}.${similar.length ? ` Similar: ${similar.join("; ")}.` : ""} Exact values: qlik_field_values`,
    );
  }
  return values.map((value) => found.get(norm(value))!);
}

export interface Selection {
  field: string;
  text: string;
}

async function currentSelections(c: Connection, doc: number): Promise<Selection[]> {
  return withSessionObject(c, doc, { qInfo: { qType: "agent-selections" }, qSelectionObjectDef: {} }, async (handle) =>
    ((await layoutOf(c, handle)).qSelectionObject.qSelections as EngineValue[]).map((s) => {
      const names = (s.qSelectedFieldSelectionInfo ?? []).map((info: EngineValue) => info.qName);
      const text = s.qSelectedCount <= 8 && names.length ? names.join(", ") : `${s.qSelectedCount} of ${s.qTotal}`;
      return { field: s.qField, text };
    }),
  );
}

export interface AppliedFilters {
  selections: Selection[];
  /** Filters Qlik dropped because no data matches them together with the rest. */
  lost: string[];
}

/** A value with `*` or a leading `<`, `>`, `=` is a Qlik search string. */
export async function applyFilters(c: Connection, doc: number, filters: Filters | undefined, fullScanLimit: number): Promise<AppliedFilters> {
  await c.call(doc, "ClearAll", { qLockedAlso: false });
  const entries = Object.entries(filters ?? {});
  for (const [field, raw] of entries) {
    const values = (Array.isArray(raw) ? raw : [raw]).map(String);
    if (!values.length) continue;
    await withSessionObject(c, doc, listbox(field), async (handle) => {
      if (values.length === 1 && isPattern(values[0]!)) {
        const { qListObject } = await layoutOf(c, handle);
        if (qListObject.qDimensionInfo.qError) throw fieldMissing(field);
        await c.call(handle, "SearchListObjectFor", { qPath: LIST, qMatch: values[0] });
        await c.call(handle, "AcceptListObjectSearch", { qPath: LIST, qToggleMode: false });
        return;
      }
      const elems = await findElems(c, handle, field, values, fullScanLimit);
      await c.call(handle, "SelectListObjectValues", { qPath: LIST, qValues: elems, qToggleMode: false });
    });
  }
  const selections = await currentSelections(c, doc);
  const lost = entries.map(([field]) => field).filter((field) => !selections.some((s) => norm(s.field) === norm(field)));
  return { selections, lost };
}

// ---------- Data ----------

function errorText(error: EngineValue): string {
  return error?.qErrorString || (error?.qErrorCode !== undefined ? `code ${error.qErrorCode}` : "unknown error");
}

function cellText(cell: EngineValue, raw: boolean): string {
  if (raw && typeof cell.qNum === "number") return String(cell.qNum);
  return cell.qIsNull ? "" : (cell.qText ?? "");
}

export interface CubeData {
  columns: string[];
  nDims: number;
  rows: string[][];
  total: number;
  totals: string[] | null;
}

async function readCube(c: Connection, doc: number, def: EngineValue, maxRows: number, raw: boolean): Promise<CubeData> {
  return withSessionObject(c, doc, { qInfo: { qType: "agent-cube" }, qHyperCubeDef: def }, async (handle) => {
    const cube = (await layoutOf(c, handle)).qHyperCube;
    const bad = [...cube.qDimensionInfo, ...cube.qMeasureInfo]
      .filter((info: EngineValue) => info.qError)
      .map((info: EngineValue) => `"${info.qFallbackTitle}": ${errorText(info.qError)}`);
    if (bad.length) throw new EngineError(`Qlik could not read: ${bad.join("; ")}`);
    if (cube.qError) {
      throw new EngineError(`Qlik did not calculate the data: ${errorText(cube.qError)}${cube.qCalcCondMsg ? ` (${cube.qCalcCondMsg})` : ""}`);
    }

    const nDims: number = cube.qDimensionInfo.length;
    const columns: string[] = [...cube.qDimensionInfo.map((d: EngineValue) => d.qFallbackTitle), ...cube.qMeasureInfo.map((m: EngineValue) => m.qFallbackTitle)];
    const total: number = cube.qSize.qcy;
    const want = Math.min(total, maxRows);
    const pageHeight = Math.max(1, Math.floor(PAGE_CELLS / Math.max(columns.length, 1)));
    const rows: string[][] = [];
    while (rows.length < want) {
      const result = await c.call(handle, "GetHyperCubeData", {
        qPath: CUBE,
        qPages: [{ qTop: rows.length, qLeft: 0, qWidth: columns.length, qHeight: Math.min(pageHeight, want - rows.length) }],
      });
      const matrix: EngineValue[][] = result.qDataPages[0]?.qMatrix ?? [];
      if (!matrix.length) break;
      rows.push(...matrix.map((row) => row.map((cell, i) => cellText(cell, raw && i >= nDims))));
    }
    const totals = nDims && cube.qGrandTotalRow?.length ? cube.qGrandTotalRow.map((cell: EngineValue) => cellText(cell, raw)) : null;
    return { columns, nDims, rows, total, totals };
  });
}

/** Turns a sheet object's data definition into a plain table: charts, pivots and KPIs all read the same way. */
function asStraightTable(def: EngineValue): EngineValue {
  const copy = structuredClone(def);
  const width = (copy.qDimensions?.length ?? 0) + (copy.qMeasures?.length ?? 0);
  copy.qMode = "S";
  copy.qInitialDataFetch = [];
  delete copy.qColumnOrder;
  copy.qInterColumnSortOrder = (copy.qInterColumnSortOrder ?? []).filter((i: number) => i >= 0 && i < width);
  return copy;
}

export async function objectData(
  c: Connection,
  doc: number,
  objectId: string,
  maxRows: number,
  raw: boolean,
): Promise<CubeData & { title: string; type: string }> {
  const handle = await getObject(c, doc, objectId);
  const layout = await layoutOf(c, handle);
  const title: string = (typeof layout.title === "string" && layout.title) || layout.qMeta?.title || objectId;
  const type: string = layout.visualization ?? layout.qInfo?.qType ?? "?";
  let props: EngineValue;
  try {
    props = (await c.call(handle, "GetEffectiveProperties")).qProp;
  } catch {
    props = (await c.call(handle, "GetProperties")).qProp;
  }
  if (!props.qHyperCubeDef) {
    if (layout.qListObject) {
      throw new EngineError(`"${title}" is a filter on field "${layout.qListObject.qDimensionInfo.qFallbackTitle}"; read its values with qlik_field_values`);
    }
    const { qInfos } = await c.call(handle, "GetChildInfos");
    if (qInfos.length) {
      throw new EngineError(`"${title}" (${type}) is a container; its data lives in the nested objects: ${qInfos.map((i: EngineValue) => i.qId).join(", ")}`);
    }
    throw new EngineError(`Object "${title}" (${type}) has no table data`);
  }
  return { title, type, ...(await readCube(c, doc, asStraightTable(props.qHyperCubeDef), maxRows, raw)) };
}

export interface QueryInput {
  dimensions?: string[];
  measures?: string[];
  maxRows: number;
  raw: boolean;
}

export async function query(c: Connection, doc: number, { dimensions = [], measures = [], maxRows, raw }: QueryInput): Promise<CubeData> {
  const { dimensions: masterDims, measures: masterMeasures } = await listFields(c, doc);
  const byTitle = <T extends { id: string; title: string }>(list: T[], ref: string) =>
    list.find((item) => norm(item.title) === norm(ref) || item.id === ref);
  const def: EngineValue = {
    qDimensions: dimensions.map((d) => {
      const master = byTitle(masterDims, d);
      return master
        ? { qLibraryId: master.id, qNullSuppression: true }
        : { qDef: { qFieldDefs: [d], qFieldLabels: [d] }, qNullSuppression: true };
    }),
    qMeasures: measures.map((m, i) => {
      const master = byTitle(masterMeasures, m);
      const sort = i === 0 && dimensions.length ? { qSortBy: { qSortByNumeric: -1 } } : {};
      if (master) return { qLibraryId: master.id, ...sort };
      return { qDef: { qDef: m.replace(/^=/, ""), qLabel: m }, ...sort };
    }),
    qSuppressZero: true,
    qMode: "S",
    qInitialDataFetch: [],
  };
  if (measures.length && dimensions.length) def.qInterColumnSortOrder = [dimensions.length, ...dimensions.map((_, i) => i)];
  return readCube(c, doc, def, maxRows, raw);
}

export interface FieldValues {
  total: number;
  possible: number;
  values: { text: string; state: string }[];
}

export async function fieldValues(c: Connection, doc: number, field: string, search: string | undefined, limit: number): Promise<FieldValues> {
  return withSessionObject(c, doc, listbox(field), async (handle) => {
    let { qListObject } = await layoutOf(c, handle);
    if (qListObject.qDimensionInfo.qError) throw fieldMissing(field);
    if (search) {
      await c.call(handle, "SearchListObjectFor", { qPath: LIST, qMatch: search });
      ({ qListObject } = await layoutOf(c, handle));
    }
    const cells = await listData(c, handle, 0, limit);
    if (search) await c.call(handle, "AbortListObjectSearch", { qPath: LIST });
    const counts = qListObject.qDimensionInfo.qStateCounts ?? {};
    return {
      total: qListObject.qSize.qcy,
      possible: (counts.qOption ?? 0) + (counts.qSelected ?? 0),
      values: cells.map((cell) => ({ text: cell.qText ?? "", state: cell.qState })),
    };
  });
}
