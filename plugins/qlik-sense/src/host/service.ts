// Everything the host entry does, independent of bb's RPC plumbing so tests can
// drive it directly: connection setup, sign-in check, the report catalog, the
// "can't find a report" link check, and the agent tools.
import { hostname } from "node:os";
import type { Catalog, CatalogApp, CheckLinkResult, ConnectionStatus, QlikAppSummary, QlikSheetSummary, ToolInput } from "../../contract.js";
import { MAX_ROWS } from "../../contract.js";
import { appLink, normalizeBaseUrl, parseQlikLink, sheetLink } from "../shared/links.js";
import { dataText, filtersText, objectLine } from "./format.js";
import { checkLogin, Session, type QlikConfig } from "./qlik/auth.js";
import { AuthError, EngineError } from "./qlik/engine.js";
import * as q from "./qlik/operations.js";
import { savePassword, storeOfKind } from "./secret-store.js";
import { StateFile } from "./state.js";

export interface ServiceOptions {
  readonly dataDir: string;
  /** Tests only: a bare engine socket, no proxy and no sign-in. */
  readonly engineUrl?: string | null;
  readonly fullScanLimit?: number;
}

interface Client {
  readonly key: string;
  readonly session: Session;
  readonly apps: Map<string, q.QlikApp>;
}

const NOT_SET_UP = `Qlik Sense is not set up on this machine (${hostname()}). Ask the user to open Qlik Sense in the bb sidebar and sign in.`;
const SETUP_HINT = "Ask the user to tick it in the bb sidebar → Qlik Sense → Reports.";

export class QlikService {
  readonly state: StateFile;
  #client: Client | null = null;

  constructor(private readonly options: ServiceOptions) {
    this.state = new StateFile(options.dataDir);
  }

  // ---------- Connection ----------

  async status(): Promise<ConnectionStatus> {
    const state = await this.state.load();
    const hasPassword = state.passwordStore !== null && (await storeOfKind(state.passwordStore, this.options.dataDir).has());
    return {
      platform: process.platform,
      url: state.url,
      user: state.user,
      hasPassword,
      passwordStore: hasPassword ? state.passwordStore : null,
      blocked: state.blocked,
      lastCheck: state.lastCheck,
      catalogApps: state.catalog.apps.length,
    };
  }

  async saveConnection(input: { url: string; user: string; password?: string }): Promise<ConnectionStatus> {
    const url = normalizeBaseUrl(input.url);
    const user = checkLogin(input.user);
    const before = await this.state.load();
    let stored: { kind: ConnectionStatus["passwordStore"]; warning: string | null } = {
      kind: before.passwordStore,
      warning: before.passwordWarning,
    };
    if (input.password !== undefined) {
      if (before.passwordStore) await storeOfKind(before.passwordStore, this.options.dataDir).clear();
      stored = await savePassword(this.options.dataDir, input.password);
    }
    const changed = input.password !== undefined || url !== before.url || user !== before.user;
    await this.state.update((state) => ({
      ...state,
      url,
      user,
      passwordStore: stored.kind,
      passwordWarning: stored.warning,
      // A new password or account is a fresh start for the sign-in guard.
      blocked: changed ? null : state.blocked,
      lastCheck: changed ? null : state.lastCheck,
      catalog: url === before.url ? state.catalog : { apps: [] },
    }));
    this.#reset();
    return this.status();
  }

  async forget(): Promise<ConnectionStatus> {
    const state = await this.state.load();
    if (state.passwordStore) await storeOfKind(state.passwordStore, this.options.dataDir).clear();
    await this.state.update((current) => ({
      ...current,
      url: null,
      user: null,
      passwordStore: null,
      passwordWarning: null,
      blocked: null,
      lastCheck: null,
      catalog: { apps: [] },
    }));
    this.#reset();
    return this.status();
  }

  async checkSignIn(retry: boolean): Promise<{ ok: boolean; message: string; apps: number | null }> {
    const state = await this.state.load();
    if (!this.options.engineUrl && (!state.url || !state.user)) return { ok: false, message: NOT_SET_UP, apps: null };
    if (retry && state.blocked) {
      await this.state.update((current) => ({ ...current, blocked: null }));
      this.#reset();
    }
    const client = await this.#ensureClient();
    try {
      if (client.session.usesForms) {
        client.session.invalidate();
        await client.session.ensure();
      }
      const apps = await this.#app(client, q.ENGINE_DATA).run((c) => q.listApps(c));
      const message = `Signed in. ${apps.length} app${apps.length === 1 ? "" : "s"} available to this account.`;
      await this.#recordCheck(true, message, apps.length);
      return { ok: true, message, apps: apps.length };
    } catch (error) {
      const message = errorMessage(error);
      await this.#recordCheck(false, message, null);
      return { ok: false, message, apps: null };
    }
  }

  // ---------- Catalog ----------

  async listApps(): Promise<QlikAppSummary[]> {
    const client = await this.#ensureClient();
    const apps = await this.#app(client, q.ENGINE_DATA).run((c) => q.listApps(c));
    return apps.sort((a, b) => (a.stream ?? "").localeCompare(b.stream ?? "") || a.name.localeCompare(b.name)).slice(0, 2000);
  }

  async listSheets(appId: string): Promise<QlikSheetSummary[]> {
    const client = await this.#ensureClient();
    const base = await this.#base();
    const sheets = await this.#app(client, appId).run((c, doc) => q.listSheets(c, doc!));
    return sheets.map((sheet) => ({
      id: sheet.id,
      title: sheet.title,
      description: sheet.description,
      published: sheet.published,
      link: base ? sheetLink(base, appId, sheet.id) : "",
    }));
  }

  async getCatalog(): Promise<Catalog> {
    return (await this.state.load()).catalog;
  }

  async saveCatalog(catalog: Catalog): Promise<Catalog> {
    return (await this.state.setCatalog(catalog)).catalog;
  }

  async checkLink(link: string): Promise<CheckLinkResult> {
    const parsed = parseQlikLink(link);
    if (!parsed) return { status: "invalid", reason: "not-a-link" };
    const base = await this.#base();
    if (base && new URL(base).origin !== parsed.origin) {
      return { status: "invalid", reason: "other-site", linkOrigin: parsed.origin, setupOrigin: new URL(base).origin };
    }
    const client = await this.#ensureClient();
    const visible = await this.#app(client, q.ENGINE_DATA).run((c) => q.listApps(c));
    const app = visible.find((candidate) => candidate.id === parsed.appId);
    if (!app) return this.#noAccess(parsed.appId, null);
    try {
      const sheets = await this.#app(client, app.id).run((c, doc) => q.listSheets(c, doc!));
      const sheet = parsed.sheetId ? sheets.find((candidate) => candidate.id === parsed.sheetId) : undefined;
      if (parsed.sheetId && !sheet) {
        return { status: "invalid", reason: "no-sheet", sheetId: parsed.sheetId };
      }
      return { status: "ok", app: { id: app.id, name: app.name, stream: app.stream }, sheet: sheet ? { id: sheet.id, title: sheet.title } : null };
    } catch (error) {
      if (error instanceof q.NoAccessError) return this.#noAccess(app.id, error.message);
      throw error;
    }
  }

  async #noAccess(appId: string, detail: string | null): Promise<CheckLinkResult> {
    return { status: "no-access", appId, user: (await this.state.load()).user ?? "", detail };
  }

  // ---------- Agent tools ----------

  async tool(input: ToolInput): Promise<{ text: string; isError: boolean }> {
    try {
      return { text: await this.#tool(input), isError: false };
    } catch (error) {
      return { text: `Error: ${errorMessage(error)}`, isError: true };
    }
  }

  async #tool(input: ToolInput): Promise<string> {
    const state = await this.state.load();
    if (!this.options.engineUrl && (!state.url || !state.user)) return NOT_SET_UP;
    const catalog = state.catalog;
    if (input.tool === "reports") return this.#reportsText(catalog);

    const entry = resolveApp(catalog, input.app);
    const client = await this.#ensureClient();
    const app = this.#app(client, entry.id);
    const scanLimit = this.options.fullScanLimit ?? 20_000;

    switch (input.tool) {
      case "sheets": {
        const sheets = await app.run((c, doc) => q.listSheets(c, doc!));
        if (!sheets.length) return "The app has no sheets.";
        const base = await this.#base();
        const ticked = new Map(entry.sheets.map((sheet) => [sheet.id, sheet]));
        return [
          `App "${entry.name}" [app: ${entry.id}]`,
          ...sheets.map((sheet) => {
            const mark = ticked.get(sheet.id);
            const extras = [
              `objects: ${sheet.objects}`,
              sheet.published === false ? "private" : null,
              mark ? `recommended${mark.note ? `: ${mark.note}` : ""}` : null,
              base ? `open: ${sheetLink(base, entry.id, sheet.id)}` : null,
            ].filter(Boolean);
            return `- "${sheet.title}" [sheet: ${sheet.id}] — ${extras.join("; ")}${sheet.description ? `. ${sheet.description}` : ""}`;
          }),
        ].join("\n");
      }
      case "sheet_objects": {
        const result = await app.run(async (c, doc) => {
          await c.call(doc!, "ClearAll", { qLockedAlso: false });
          return q.sheetObjects(c, doc!, input.sheet);
        });
        return [`Sheet "${result.sheet.title}" [sheet: ${result.sheet.id}]`, "", ...result.objects.map((object) => objectLine(object))].join("\n");
      }
      case "fields": {
        const result = await app.run((c, doc) => q.listFields(c, doc!));
        const search = input.search?.toLowerCase();
        const match = (value: string) => !search || value.toLowerCase().includes(search);
        const fields = result.fields.filter((field) => match(field.name));
        const dims = result.dimensions.filter((dim) => match(dim.title));
        const measures = result.measures.filter((measure) => match(measure.title));
        const out = [
          `Fields (${fields.length}):`,
          ...fields.slice(0, 300).map((field) => `- ${field.name}${field.cardinal !== null ? ` — ${field.cardinal} values` : ""}`),
        ];
        if (dims.length) out.push("", `Master dimensions (${dims.length}):`, ...dims.map((dim) => `- ${dim.title}${dim.field ? ` — ${dim.field}` : ""}`));
        if (measures.length) out.push("", `Master measures (${measures.length}):`, ...measures.map((measure) => `- ${measure.title} — ${measure.expr}`));
        return out.join("\n");
      }
      case "field_values": {
        const { applied, values } = await app.run(async (c, doc) => {
          const applied = await q.applyFilters(c, doc!, input.filters, scanLimit);
          return { applied, values: await q.fieldValues(c, doc!, input.field, input.search, input.limit ?? 100) };
        });
        const mark: Record<string, string> = { S: " [selected]", X: " [excluded]", XS: " [excluded]", A: " [alternative]" };
        return [
          `Field "${input.field}": ${values.total} values, ${values.possible} possible with these filters`,
          filtersText(applied),
          "",
          ...values.values.map((value) => `- ${value.text}${mark[value.state] ?? ""}`),
        ].join("\n");
      }
      case "get_data": {
        const { applied, data } = await app.run(async (c, doc) => {
          const applied = await q.applyFilters(c, doc!, input.filters, scanLimit);
          return { applied, data: await q.objectData(c, doc!, input.object, Math.min(input.maxRows ?? 100, MAX_ROWS), input.rawNumbers ?? false) };
        });
        return dataText(`"${data.title}" (${data.type})`, data, applied);
      }
      case "query": {
        if (!input.dimensions?.length && !input.measures?.length) throw new Error("Give at least one dimension or measure");
        const { applied, data } = await app.run(async (c, doc) => {
          const applied = await q.applyFilters(c, doc!, input.filters, scanLimit);
          const data = await q.query(c, doc!, {
            dimensions: input.dimensions,
            measures: input.measures,
            maxRows: Math.min(input.maxRows ?? 100, MAX_ROWS),
            raw: input.rawNumbers ?? false,
          });
          return { applied, data };
        });
        return dataText("Custom breakdown", data, applied);
      }
    }
  }

  async #reportsText(catalog: Catalog): Promise<string> {
    if (!catalog.apps.length) {
      return "No Qlik Sense reports are enabled yet. Ask the user to open Qlik Sense in the bb sidebar, sign in, and tick the reports you may use.";
    }
    const base = await this.#base();
    const lines = ["Qlik Sense reports enabled for you. Only these apps can be read; every other app is refused.", ""];
    for (const app of catalog.apps) {
      lines.push(`## ${app.name} [app: ${app.id}]${app.stream ? ` — stream "${app.stream}"` : ""}`);
      if (app.note) lines.push(`Use for: ${app.note}`);
      if (base) lines.push(`Open: ${appLink(base, app.id)}`);
      if (app.sheets.length) {
        lines.push("Start with these sheets:");
        for (const sheet of app.sheets) {
          const link = base ? ` Open: ${sheetLink(base, app.id, sheet.id)}` : "";
          lines.push(`- "${sheet.title}" [sheet: ${sheet.id}]${sheet.note ? ` — ${sheet.note}.` : "."}${link}`);
        }
      }
      lines.push("");
    }
    lines.push(
      "Workflow: qlik_sheet_objects (object ids, dimensions, measures) → qlik_field_values (exact filter values) → qlik_get_data with filters. " +
        "For a breakdown no sheet shows, use qlik_query. Give the user the sheet link next to your answer so they can check it in Qlik.",
    );
    return lines.join("\n");
  }

  // ---------- Internals ----------

  async #base(): Promise<string | null> {
    return (await this.state.load()).url;
  }

  async #recordCheck(ok: boolean, message: string, apps: number | null): Promise<void> {
    await this.state.update((state) => ({ ...state, lastCheck: { ok, at: Date.now(), message, apps } }));
  }

  async #ensureClient(): Promise<Client> {
    const state = await this.state.load();
    const engineUrl = this.options.engineUrl ?? null;
    if (!engineUrl && (!state.url || !state.user)) throw new AuthError(NOT_SET_UP);
    const key = JSON.stringify([engineUrl, state.url, state.user, state.passwordStore, state.identity]);
    if (this.#client?.key === key) return this.#client;
    this.#reset();
    const config: QlikConfig = {
      base: engineUrl ? null : state.url,
      engineUrl,
      user: state.user,
      identity: state.identity,
      fullScanLimit: this.options.fullScanLimit ?? 20_000,
    };
    const dataDir = this.options.dataDir;
    const session = new Session(
      config,
      {
        async password() {
          const kind = state.passwordStore;
          const password = kind ? await storeOfKind(kind, dataDir).read() : null;
          if (!password) throw new AuthError("No Qlik password is saved on this machine. Enter it in the Qlik Sense panel.");
          return password;
        },
      },
      {
        blockedReason: () => this.state.current().blocked,
        block: async (reason) => {
          await this.state.update((current) => ({ ...current, blocked: reason }));
        },
      },
    );
    this.#client = { key, session, apps: new Map() };
    return this.#client;
  }

  #app(client: Client, appId: string): q.QlikApp {
    let app = client.apps.get(appId);
    if (!app) {
      app = new q.QlikApp(client.session, appId);
      client.apps.set(appId, app);
    }
    return app;
  }

  #reset(): void {
    for (const app of this.#client?.apps.values() ?? []) app.close();
    this.#client = null;
  }

  close(): void {
    this.#reset();
  }
}

/** Finds the ticked app an agent means: by id, exact name, or a unique part of the name. */
export function resolveApp(catalog: Catalog, ref: string | undefined): CatalogApp {
  const apps = catalog.apps;
  if (!apps.length) throw new Error(`No Qlik Sense reports are enabled for agents. ${SETUP_HINT}`);
  const list = () => apps.map((app) => `"${app.name}" [app: ${app.id}]`).join("; ");
  if (!ref) {
    if (apps.length === 1) return apps[0]!;
    throw new Error(`Several apps are enabled; pass app (an id or a name): ${list()}`);
  }
  const wanted = ref.trim().toLowerCase();
  const byId = apps.find((app) => app.id === ref.trim());
  if (byId) return byId;
  const exact = apps.filter((app) => app.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]!;
  const partial = apps.filter((app) => app.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new Error(`"${ref}" matches several enabled apps: ${partial.map((app) => `"${app.name}" [app: ${app.id}]`).join("; ")}`);
  throw new Error(`App "${ref}" is not enabled for agents. Enabled: ${list()}. ${SETUP_HINT}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthError || error instanceof EngineError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
