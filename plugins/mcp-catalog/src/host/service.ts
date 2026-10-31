// The machine's list of MCP servers and everything done to it.
//
// state.json (0600, in the plugin's host data directory) keeps addresses,
// plain headers, on/off, timeouts and the last check — never a token. Tokens
// live in the OS credential store. For a server that is on, the token is also
// written to a 0600 file that opencode.json refers to with `{file:…}`.
//
// Every pasted token gets a new store key (and so a new file name). The old
// key is retired, not overwritten: it is deleted only after opencode.json no
// longer refers to it. A paste that fails half way leaves nothing behind, and
// OpenCode — which watches opencode.json but not the token files — sees the
// reference change and loads the new token.
//
// Order, so OpenCode never meets a reference to a missing file: token files
// first, then opencode.json; when switching off, opencode.json first, then the
// files.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogItem, Health, ImportResult, ServerView, Status, WriteConfig } from "../../contract.js";
import { ConfigTextError, isCredential, maskAddress, parseClientConfig, splitScheme, urlProblem } from "../shared/parse-config.js";
import { CatalogError, fetchCatalog } from "./catalog.js";
import { findOpenCode } from "./find-opencode.js";
import { summaryOf, templateFor, titleOf, type ServerInfo, type Template } from "./names.js";
import { ConfigFileError, writeMcpServers, type McpEntry } from "./opencode-mcp.js";
import { resolveOpenCodeLocation } from "./opencode-location.js";
import { probeServer, type ProbeResult } from "./probe.js";
import { checkSecretValue, openSecretStore, type SecretStore } from "./secret-store.js";

const PARALLEL_CHECKS = 3;
const CATALOG_TTL_MS = 5 * 60_000;
/** How long an answer other than "OpenCode 2 or later" is trusted: the person may be updating OpenCode right now. */
const VERSION_RECHECK_MS = 60_000;

interface StoredHeader {
  name: string;
  /** A plain value, kept here. */
  value?: string;
  /** The OS store key holding the credential part; also the token file's name. */
  secret?: string;
  /** Fixed text before the credential, such as "Bearer ". */
  prefix?: string;
}

interface StoredServer {
  url: string;
  headers: StoredHeader[];
  enabled: boolean;
  timeoutSec: number | null;
  addedAt: number;
  health: Health;
  /** The catalog template this server was made from, as last matched. */
  template?: Template | null;
  /** What the server said about itself on its last answer. */
  info?: ServerInfo | null;
}

interface State {
  version: 1;
  servers: Record<string, StoredServer>;
  /** Names this plugin wrote under `mcp.servers`, and the file they are in. */
  owned: string[];
  ownedFile: string | null;
  /** Names held in that file by entries this plugin did not write. */
  conflicts: string[];
  /** Store keys replaced by newer tokens, deleted once opencode.json no longer refers to them. */
  retired: string[];
  configFile: string | null;
  configError: string | null;
}

const EMPTY_HEALTH: Health = { status: "unknown", since: null, checkedAt: null, detail: null, tools: null };
const emptyState = (): State => ({ version: 1, servers: {}, owned: [], ownedFile: null, conflicts: [], retired: [], configFile: null, configError: null });

/** An error the panel shows in the person's language: "[mcp:<code>] English text". */
export class TaggedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[mcp:${code}] ${message}`);
  }
}

/** A fresh store key for one header of one server: stable prefix, new suffix per token. */
export function secretName(server: string, header: string, version: string = randomUUID().slice(0, 8)): string {
  return `t-${createHash("sha256").update(`${server}\n${header.toLowerCase()}`).digest("hex").slice(0, 24)}-${version}`;
}

/** A path as `{file:…}` carries it: forward slashes, which OpenCode reads on every system. */
export function fileReference(path: string): string {
  const portable = path.replace(/\\/g, "/");
  if (/[{}"\x00-\x1f]/.test(portable)) throw new TaggedError("config-failed", "The plugin's data directory has characters a {file:} reference cannot carry.");
  return `{file:${portable}}`;
}

/** Own properties only: a server called "constructor" must not find Object's. */
const serverOf = (state: State, name: string): StoredServer | undefined => (Object.hasOwn(state.servers, name) ? state.servers[name] : undefined);
const secretsOf = (server: StoredServer | undefined) => (server?.headers ?? []).map((header) => header.secret).filter((key): key is string => Boolean(key));

/** An OpenCode executable and its version. */
export interface OpenCodeFound {
  major: number | null;
  version: string;
  path: string;
}

export interface ServiceOptions {
  dataDir: string;
  store?: SecretStore;
  env?: NodeJS.ProcessEnv;
  /** The home directory OpenCode falls back to; tests point it elsewhere. Default: os.homedir(). */
  userHome?: string;
  fetchImpl?: typeof fetch;
  /** The OpenCode on the given PATH, or null when none is found. Default: `opencode --version`. */
  openCode?: (environment: NodeJS.ProcessEnv) => Promise<OpenCodeFound | null>;
  now?: () => number;
}

export class McpService {
  private state: Promise<State> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tokens = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private catalogCache: { url: string; at: number; items: CatalogItem[] } | null = null;
  private openCodeSeen: { path: string; at: number; found: OpenCodeFound | null } | null = null;
  private readonly store: SecretStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(private readonly options: ServiceOptions) {
    this.store = options.store ?? openSecretStore("auto");
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  private get stateFile() {
    return join(this.options.dataDir, "state.json");
  }
  private get tokenDir() {
    return join(this.options.dataDir, "tokens");
  }

  /** One change at a time: calls from the panel, agents and the scheduler interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The state, read once per worker; concurrent first calls share the read. */
  private load(): Promise<State> {
    this.state ??= this.read().catch((error: unknown) => {
      this.state = null;
      throw error;
    });
    return this.state;
  }

  private async read(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<State>;
      if (value?.version !== 1 || typeof value.servers !== "object" || value.servers === null) throw new Error("unknown state");
      return { ...emptyState(), ...value, servers: value.servers };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        if (!(error instanceof SyntaxError) && (error as Error).message !== "unknown state") throw error;
        // Unreadable: kept aside for a person to look at, never silently overwritten.
        await rename(this.stateFile, `${this.stateFile}.broken-${this.now()}`).catch(() => undefined);
      }
      return emptyState();
    }
  }

  private async save(): Promise<void> {
    const state = await this.load();
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.stateFile);
  }

  private view(state: State): Status {
    const servers: ServerView[] = Object.entries(state.servers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, server]) => ({
        name,
        title: titleOf(name, server.template, server.info),
        summary: summaryOf(server.template, server.info),
        address: maskAddress(server.url),
        enabled: server.enabled,
        timeoutSec: server.timeoutSec,
        headers: server.headers.map((header) => header.name),
        secretHeaders: server.headers.filter((header) => header.secret).map((header) => header.name),
        conflict: server.enabled && state.conflicts.includes(name),
        addedAt: server.addedAt,
        health: server.health,
      }));
    return { servers, configFile: state.configFile, configError: state.configError, store: this.store.label };
  }

  async status(): Promise<Status> {
    return this.view(await this.load());
  }

  private async token(key: string): Promise<string | null> {
    const cached = this.tokens.get(key);
    if (cached !== undefined) return cached;
    const value = await this.store.get(key);
    if (value !== null) this.tokens.set(key, value);
    return value;
  }

  /** Header values with the credentials filled in; null when a credential is missing from the store. */
  private async resolvedHeaders(server: StoredServer): Promise<Record<string, string> | null> {
    const headers: Record<string, string> = {};
    for (const header of server.headers) {
      if (header.secret) {
        const value = await this.token(header.secret);
        if (value === null) return null;
        headers[header.name] = `${header.prefix ?? ""}${value}`;
      } else {
        headers[header.name] = header.value ?? "";
      }
    }
    return headers;
  }

  // ---------------------------------------------------------------- changes

  importConfig(text: string, config: WriteConfig): Promise<ImportResult> {
    return this.serial(async () => {
      let parsed;
      try {
        parsed = parseClientConfig(text, { allowHttp: config.allowHttp === true });
      } catch (error) {
        if (error instanceof ConfigTextError) throw new TaggedError(error.code, error.message);
        throw error;
      }
      const state = await this.load();

      // Everything new is prepared and stored under new keys first; the state changes only when all of it worked.
      const prepared: { name: string; server: StoredServer; previous: StoredServer | undefined }[] = [];
      const written: string[] = [];
      try {
        for (const server of parsed.servers) {
          const previous = serverOf(state, server.name);
          const headers: StoredHeader[] = [];
          for (const header of server.headers) {
            if (!isCredential(header.name, header.value)) {
              headers.push({ name: header.name, value: header.value });
              continue;
            }
            const { prefix, secret } = splitScheme(header.value);
            const key = secretName(server.name, header.name);
            try {
              const value = checkSecretValue(secret);
              await this.store.set(key, value);
              written.push(key);
              this.tokens.set(key, value);
            } catch (error) {
              throw new TaggedError("store-failed", `Could not save the ${header.name} of ${server.name} in ${this.store.label}: ${(error as Error).message}`);
            }
            headers.push({ name: header.name, secret: key, ...(prefix ? { prefix } : {}) });
          }
          prepared.push({
            name: server.name,
            previous,
            server: {
              url: server.url,
              headers,
              enabled: previous?.enabled ?? true,
              timeoutSec: previous?.timeoutSec ?? null,
              addedAt: previous?.addedAt ?? this.now(),
              health: { ...EMPTY_HEALTH },
              template: previous?.template ?? null,
              info: previous?.info ?? null,
            },
          });
        }
      } catch (error) {
        for (const key of written) {
          this.tokens.delete(key);
          await this.store.delete(key).catch(() => false);
        }
        throw error;
      }

      const added: string[] = [];
      const updated: string[] = [];
      for (const { name, server, previous } of prepared) {
        state.retired.push(...secretsOf(previous));
        state.servers[name] = server;
        (previous ? updated : added).push(name);
      }
      const cached = this.catalogCache;
      if (cached && cached.url === (config.catalogUrl ?? "").trim()) this.applyTemplates(state, cached.items);
      await this.save();
      await this.syncLocked(config, new Set());
      return { added, updated, skipped: parsed.skipped, status: this.view(state) };
    });
  }

  setEnabled(name: string, enabled: boolean, replace: boolean, config: WriteConfig): Promise<Status> {
    return this.serial(async () => {
      const state = await this.load();
      const server = serverOf(state, name);
      if (!server) throw new TaggedError("not-found", `There is no MCP server called ${name} on this machine.`);
      server.enabled = enabled;
      await this.save();
      await this.syncLocked(config, enabled && replace ? new Set([name]) : new Set());
      return this.view(state);
    });
  }

  setTimeout(name: string, timeoutSec: number | null, config: WriteConfig): Promise<Status> {
    return this.serial(async () => {
      const state = await this.load();
      const server = serverOf(state, name);
      if (!server) throw new TaggedError("not-found", `There is no MCP server called ${name} on this machine.`);
      server.timeoutSec = timeoutSec;
      await this.save();
      await this.syncLocked(config, new Set());
      return this.view(state);
    });
  }

  remove(name: string, config: WriteConfig): Promise<Status> {
    return this.serial(async () => {
      const state = await this.load();
      const server = serverOf(state, name);
      if (!server) return this.view(state);
      const wasEnabled = server.enabled;
      server.enabled = false;
      await this.syncLocked(config, new Set());
      if (state.owned.includes(name)) {
        // opencode.json could not be written: put the server back as it was, so the list says what OpenCode uses.
        server.enabled = wasEnabled;
        await this.save();
        throw new TaggedError("remove-failed", `${name} was not removed because opencode.json could not be written (${state.configError ?? "unknown error"}). Nothing changed; try again.`);
      }
      for (const key of secretsOf(server)) await this.forgetSecret(key);
      delete state.servers[name];
      state.conflicts = state.conflicts.filter((item) => item !== name);
      await this.save();
      return this.view(state);
    });
  }

  sync(config: WriteConfig): Promise<Status> {
    return this.serial(async () => {
      await this.syncLocked(config, new Set());
      return this.view(await this.load());
    });
  }

  private async forgetSecret(key: string): Promise<void> {
    this.tokens.delete(key);
    await this.store.delete(key).catch(() => false);
    await rm(join(this.tokenDir, key), { force: true });
  }

  /**
   * The OpenCode to judge: the first `opencode` on bb's own PATH, which the
   * server sends for its own machine; elsewhere the worker's PATH. bb gives
   * its daemon and workers a rebuilt PATH with the login shell's entries
   * first, where a personal OpenCode may come before the one a build put
   * first on bb's PATH.
   */
  private async openCode(environment: NodeJS.ProcessEnv): Promise<OpenCodeFound | null> {
    const path = environment.PATH ?? environment.Path ?? "";
    const known = this.openCodeSeen;
    if (known && known.path === path && ((known.found?.major ?? 0) >= 2 || this.now() - known.at < VERSION_RECHECK_MS)) return known.found;
    const found = this.options.openCode
      ? await this.options.openCode(environment)
      : await findOpenCode(environment).then(
          (binary) => (binary ? { major: Number(/^(\d+)\./.exec(binary.version)?.[1] ?? NaN) || null, version: binary.version, path: binary.command[0] } : null),
          () => null,
        );
    this.openCodeSeen = { path, at: this.now(), found };
    return found;
  }

  private async writeTokenFile(name: string, value: string): Promise<string> {
    await mkdir(this.tokenDir, { recursive: true, mode: 0o700 });
    await chmod(this.tokenDir, 0o700).catch(() => undefined);
    const target = join(this.tokenDir, name);
    const temporary = join(this.tokenDir, `.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    return target;
  }

  /** opencode.json, the token files and retired keys, made to match the saved list. Called inside serial(). */
  private async syncLocked(config: WriteConfig, replace: ReadonlySet<string>): Promise<void> {
    const state = await this.load();
    try {
      const environment = { ...this.env, ...config.serverEnvironment };
      const location = resolveOpenCodeLocation({ opencodeConfigDir: config.opencodeConfigDir, environment, userHome: this.options.userHome });
      state.configFile = location.configFile;
      const enabled = Object.entries(state.servers).filter(([, server]) => server.enabled);
      const openCode = enabled.length > 0 ? await this.openCode(environment) : null;
      if (openCode?.major === 1) {
        throw new TaggedError(
          "opencode-1",
          `The OpenCode on bb's PATH on this machine is ${openCode.version} (${openCode.path}); MCP Catalog writes the OpenCode 2 configuration. Update OpenCode to 2.`,
        );
      }

      // The configuration moved (a setting changed): take this plugin's entries out of the old file first,
      // so names there are not orphaned and names in the new file are judged afresh.
      if (state.ownedFile !== null && state.ownedFile !== location.configFile) {
        if (state.owned.length > 0) await writeMcpServers(state.ownedFile, [], state.owned, new Set());
        state.owned = [];
        state.conflicts = [];
      }
      state.ownedFile = location.configFile;

      const wanted: McpEntry[] = [];
      for (const [name, server] of enabled) {
        const headers: Record<string, string> = {};
        let missing = false;
        for (const header of server.headers) {
          if (!header.secret) {
            headers[header.name] = header.value ?? "";
            continue;
          }
          const value = await this.token(header.secret);
          if (value === null) {
            missing = true;
            break;
          }
          const path = await this.writeTokenFile(header.secret, value);
          headers[header.name] = `${header.prefix ?? ""}${fileReference(path)}`;
        }
        if (missing) {
          this.recordHealth(server, { status: "unauthorized", detail: "token missing from the OS store", tools: null });
          continue;
        }
        const timeoutSec = server.timeoutSec ?? (config.timeoutSec > 0 ? config.timeoutSec : null);
        const value: Record<string, unknown> = { type: "remote", url: server.url };
        if (Object.keys(headers).length > 0) value.headers = headers;
        // The token is in the headers; OpenCode should not start an OAuth sign-in when it is refused.
        if (server.headers.some((header) => header.secret)) value.oauth = false;
        if (timeoutSec !== null) value.timeout = { execution: timeoutSec * 1000 };
        wanted.push({ name, value });
      }
      const result = await writeMcpServers(location.configFile, wanted, state.owned, replace);
      state.owned = result.owned;
      state.conflicts = result.conflicts;
      state.configError = null;

      // Token files only for entries that are in opencode.json now; retired keys go for good.
      const live = new Set(result.owned.flatMap((name) => secretsOf(serverOf(state, name))));
      for (const entry of await readdir(this.tokenDir).catch(() => [] as string[])) {
        if (!live.has(entry)) await rm(join(this.tokenDir, entry), { force: true });
      }
      for (const key of state.retired) await this.forgetSecret(key);
      state.retired = [];
    } catch (error) {
      state.configError = describeWriteError(error);
    }
    await this.save();
  }

  // ---------------------------------------------------------------- checks

  private recordHealth(server: StoredServer, result: ProbeResult): void {
    const at = this.now();
    const previous = server.health;
    server.health = {
      status: result.status,
      since: previous.status === result.status && previous.since !== null ? previous.since : at,
      checkedAt: at,
      detail: result.detail,
      tools: result.status === "ok" ? result.tools : null,
    };
    if (result.info) server.info = result.info;
  }

  /** Check servers whose last check is older than maxAgeMs, a few at a time. A failed write of opencode.json is retried first. */
  async check(names: string[] | undefined, maxAgeMs: number, config: WriteConfig, signal?: AbortSignal): Promise<Status> {
    const state = await this.load();
    if (state.configError !== null) await this.sync(config);
    // Names come from the catalog; an unreachable catalog keeps the names matched before.
    await this.refreshTemplates(config).catch(() => undefined);
    const now = this.now();
    const due = Object.entries(state.servers)
      .filter(([name]) => names === undefined || names.includes(name))
      .filter(([, server]) => server.health.checkedAt === null || now - server.health.checkedAt >= maxAgeMs)
      .map(([name]) => name);
    const queue = [...due];
    const workers = Array.from({ length: Math.min(PARALLEL_CHECKS, queue.length) }, async () => {
      while (queue.length > 0) {
        signal?.throwIfAborted();
        await this.checkOne(queue.shift()!, config.allowHttp === true, signal);
      }
    });
    await Promise.all(workers);
    return this.view(await this.load());
  }

  private checkOne(name: string, allowHttp: boolean, signal?: AbortSignal): Promise<void> {
    const running = this.inflight.get(name);
    if (running) return running;
    const run = (async () => {
      const server = serverOf(await this.load(), name);
      if (!server) return;
      const headers = await this.resolvedHeaders(server).catch(() => null);
      const problem = urlProblem(server.url, allowHttp);
      const result: ProbeResult =
        problem !== null
          ? { status: "down", detail: "address not allowed", tools: null }
          : headers === null
            ? { status: "unauthorized", detail: "token missing from the OS store", tools: null }
            : await probeServer(server.url, headers, { signal, fetchImpl: this.options.fetchImpl });
      await this.serial(async () => {
        const current = serverOf(await this.load(), name);
        // Replaced or removed meanwhile: this result is about the old settings.
        if (current !== server) return;
        this.recordHealth(current, result);
        await this.save();
      });
    })().finally(() => this.inflight.delete(name));
    this.inflight.set(name, run);
    return run;
  }

  // ---------------------------------------------------------------- catalog

  /** Match every server to its catalog template, from the catalog read at most every few minutes. */
  private async refreshTemplates(config: WriteConfig): Promise<void> {
    const url = (config.catalogUrl ?? "").trim();
    const catalog = url === "" ? { items: [], error: null } : await this.catalog(url, false, config.allowHttp === true);
    if (catalog.error !== null && catalog.items.length === 0) return;
    await this.serial(async () => {
      const state = await this.load();
      if (this.applyTemplates(state, catalog.items)) await this.save();
    });
  }

  /** Whether any server's template changed. */
  private applyTemplates(state: State, items: readonly CatalogItem[]): boolean {
    let changed = false;
    for (const [name, server] of Object.entries(state.servers)) {
      const item = templateFor(name, items);
      const next: Template | null = item ? { id: item.id, name: item.name, description: item.description } : null;
      if (JSON.stringify(next) !== JSON.stringify(server.template ?? null)) {
        server.template = next;
        changed = true;
      }
    }
    return changed;
  }

  async catalog(url: string, refresh: boolean, allowHttp = false) {
    const address = url.trim();
    if (address === "") return { items: [], fetchedAt: null, error: null };
    const cached = this.catalogCache;
    if (!refresh && cached && cached.url === address && this.now() - cached.at < CATALOG_TTL_MS) {
      return { items: cached.items, fetchedAt: cached.at, error: null };
    }
    try {
      if (/^http:/i.test(address) && !allowHttp) {
        // Read without credentials, so plain http only risks the catalog's text; still, ask for https.
        throw new CatalogError("catalog-address", "The catalog address must start with https://.");
      }
      const items = await fetchCatalog(address, { fetchImpl: this.options.fetchImpl });
      this.catalogCache = { url: address, at: this.now(), items };
      return { items, fetchedAt: this.catalogCache.at, error: null };
    } catch (error) {
      const message = error instanceof CatalogError ? error.message : `[mcp:catalog-unreachable] ${(error as Error).message}`;
      return { items: cached?.url === address ? cached.items : [], fetchedAt: cached?.url === address ? cached.at : null, error: message };
    }
  }
}

function describeWriteError(error: unknown): string {
  if (error instanceof TaggedError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/configuration is busy/i.test(message)) return `[mcp:config-busy] ${message}`;
  if (error instanceof ConfigFileError) return `[mcp:config-invalid] ${message}`;
  return `[mcp:config-failed] ${message}`;
}
