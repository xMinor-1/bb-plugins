// Read MCP client settings a person pasted: the remote servers in them, with
// their addresses and headers. Accepted shapes, whole files or fragments:
//
//   OpenCode 2   { "mcp": { "servers": { "<name>": { "type": "remote", "url", "headers" } } } }
//   OpenCode 1   { "mcp": { "<name>": { "type": "remote", "url", "headers" } } }
//   Claude, Cursor and most clients   { "mcpServers": { "<name>": { "url", "headers" } } }
//   VS Code      { "servers": { "<name>": { "type": "http", "url", "headers" } } }
//   or the inner map alone: { "<name>": { "url": … } }, or `"mcp": { … }` without braces.
//
// Only remote servers are taken. Values that refer to something else
// (`{env:…}`, `{file:…}`, `${…}`) are refused: the plugin cannot know what they
// hold. Nothing here logs or returns header values except in `servers`.
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { SERVER_NAME, type Skip } from "../../contract.js";

export interface ParsedServer {
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

export interface ParsedConfig {
  servers: ParsedServer[];
  skipped: Skip[];
}

export class ConfigTextError extends Error {
  constructor(readonly code: "not-json" | "no-servers") {
    super(code === "not-json" ? "The pasted text is not JSON client settings." : "The pasted settings name no remote MCP servers.");
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Names a client reserves inside `mcp`, never servers. */
const RESERVED = new Set(["servers", "timeout", "$schema"]);
const REMOTE_TYPES = new Set(["remote", "http", "streamable-http", "streamablehttp", "streamable_http", "sse"]);
/** A substitution the client would expand, closed or not: `{env:…}`, `{file:…}`, `${…}`. */
const REFERENCE = /\{(?:env|file):|\$\{/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Query parameters that carry a credential. */
const SECRET_PARAM = /token|key|secret|password|passwd|auth|session|signature|sig$/i;

function parseObject(text: string): Json | null {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && isObject(value) ? value : null;
}

/** The text as an object: a whole file, or a fragment such as `"mcp": { … }`. */
function readText(text: string): Json {
  const trimmed = text.trim().replace(/^﻿/, "");
  const whole = parseObject(trimmed);
  if (whole) return whole;
  const fragment = parseObject(`{${trimmed.replace(/,\s*$/, "")}}`);
  if (fragment) return fragment;
  throw new ConfigTextError("not-json");
}

const looksLikeServer = (value: unknown) =>
  isObject(value) && (typeof value.url === "string" || typeof value.serverUrl === "string" || typeof value.httpUrl === "string" || Array.isArray(value.command) || typeof value.command === "string");

const isServerMap = (value: unknown): value is Json =>
  isObject(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, entry]) => RESERVED.has(key) || looksLikeServer(entry));

/** Every `name → entry` pair the settings declare, in order, from all the shapes above. */
function entriesOf(root: Json): [string, unknown][] {
  const found: [string, unknown][] = [];
  const take = (map: Json) => {
    for (const [name, entry] of Object.entries(map)) if (!RESERVED.has(name)) found.push([name, entry]);
  };
  const mcp = root.mcp;
  if (isObject(mcp)) {
    if (isObject(mcp.servers)) take(mcp.servers);
    take(mcp);
  }
  if (isObject(root.mcpServers)) take(root.mcpServers);
  if (isObject(root.servers) && isServerMap(root.servers)) take(root.servers);
  if (found.length === 0 && isServerMap(root)) take(root);
  return found;
}

export function isLocalAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Why an address cannot carry a token, or null when it can. */
export function urlProblem(raw: string, allowHttp: boolean): Skip["reason"] | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "bad-url";
  }
  if (url.username || url.password) return "url-secret";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) return url.protocol === "http:" ? "insecure-url" : "bad-url";
  if ([...url.searchParams.keys()].some((key) => SECRET_PARAM.test(key))) return "url-secret";
  return null;
}

function server(name: string, entry: unknown, allowHttp: boolean): ParsedServer | Skip["reason"] {
  if (!SERVER_NAME.test(name) || RESERVED.has(name)) return "bad-name";
  if (!isObject(entry)) return "no-url";
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : null;
  if (type === "local" || type === "stdio" || entry.command !== undefined) return "local";
  if (type !== null && !REMOTE_TYPES.has(type)) return "bad-url";
  const url = [entry.url, entry.serverUrl, entry.httpUrl].find((value): value is string => typeof value === "string");
  if (url === undefined || url.trim() === "") return "no-url";
  if (REFERENCE.test(url)) return "reference";
  const problem = urlProblem(url.trim(), allowHttp);
  if (problem !== null) return problem;
  const headers: ParsedServer["headers"] = [];
  if (entry.headers !== undefined) {
    if (!isObject(entry.headers)) return "bad-headers";
    const seen = new Set<string>();
    for (const [header, value] of Object.entries(entry.headers)) {
      if (!HEADER_NAME.test(header) || typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || value.length > 8192) return "bad-headers";
      if (REFERENCE.test(value) || REFERENCE.test(header)) return "reference";
      if (seen.has(header.toLowerCase())) return "bad-headers";
      seen.add(header.toLowerCase());
      headers.push({ name: header, value: value.trim() });
    }
  }
  return { name, url: url.trim(), headers };
}

export function parseClientConfig(text: string, options: { allowHttp?: boolean } = {}): ParsedConfig {
  const entries = entriesOf(readText(text));
  if (entries.length === 0) throw new ConfigTextError("no-servers");
  const servers: ParsedServer[] = [];
  const skipped: Skip[] = [];
  const names = new Set<string>();
  for (const [name, entry] of entries) {
    const shownName = name.slice(0, 80);
    if (names.has(name)) {
      skipped.push({ name: shownName, reason: "duplicate" });
      continue;
    }
    names.add(name);
    const result = server(name, entry, options.allowHttp === true);
    if (typeof result === "string") skipped.push({ name: shownName, reason: result });
    else servers.push(result);
  }
  if (servers.length === 0 && skipped.length === 0) throw new ConfigTextError("no-servers");
  return { servers, skipped };
}

/** Headers whose names say they carry a credential. */
export function isSecretHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|cookie)$/i.test(name) || /token|key|secret|auth|password|pass$|pat$|jwt|session|credential|signature/i.test(name);
}

/** A value that looks like a token whatever the header is called: long, no spaces, letters and digits. */
function looksLikeToken(value: string): boolean {
  const { secret } = splitScheme(value);
  return secret.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(secret) && /[A-Za-z]/.test(secret) && /\d/.test(secret);
}

/** Whether a header goes to the OS store: by its name, or by a value that looks like a token. */
export function isCredential(name: string, value: string): boolean {
  return isSecretHeader(name) || looksLikeToken(value);
}

/**
 * Split a credential header into a fixed scheme and the secret part, so a
 * Keychain entry holds only the token: "Bearer abc" → ["Bearer ", "abc"].
 */
export function splitScheme(value: string): { prefix: string; secret: string } {
  const match = /^(Bearer|Token|Basic|Bot|ApiKey|Api-Key)\s+(\S+)$/i.exec(value.trim());
  return match ? { prefix: `${match[1]} `, secret: match[2]! } : { prefix: "", secret: value.trim() };
}
