// A Streamable HTTP MCP server for tests: answers initialize and tools/list,
// refuses a wrong token with 401, can answer as SSE, fail, hang or redirect.
// It records requests with `authOk`, never the header value. The docker
// end-to-end check has its own plain-JS stub (e2e/stub-servers.mjs).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubOptions {
  /** The token the stub accepts as `Authorization: Bearer <token>`; null accepts anything. */
  token: string | null;
  mode?: "json" | "sse";
  /** Answer every request with this HTTP status instead. */
  fail?: number;
  /** Never answer. */
  hang?: boolean;
  /** Answer 302 to this address. */
  redirectTo?: string;
  tools?: number;
}

export interface StubRequest {
  method: string;
  path: string;
  rpc: string | null;
  authOk: boolean;
  session: string | null;
}

export interface Stub {
  url: string;
  requests: StubRequest[];
  options: StubOptions;
  close(): Promise<void>;
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => resolve(text));
  });
}

export async function startStubMcp(options: StubOptions, port = 0, host = "127.0.0.1"): Promise<Stub> {
  const requests: StubRequest[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const text = await body(request);
    const auth = request.headers.authorization ?? "";
    const authOk = options.token === null || auth === `Bearer ${options.token}`;
    let rpc: string | null = null;
    let message: { id?: number; method?: string } | null = null;
    try {
      message = text ? (JSON.parse(text) as { id?: number; method?: string }) : null;
      rpc = message?.method ?? null;
    } catch {
      rpc = null;
    }
    requests.push({ method: request.method ?? "", path: request.url ?? "", rpc, authOk, session: (request.headers["mcp-session-id"] as string | undefined) ?? null });
    if (options.hang) return;
    if (options.redirectTo) {
      response.writeHead(302, { location: options.redirectTo });
      response.end();
      return;
    }
    if (options.fail) {
      response.writeHead(options.fail);
      response.end("failure");
      return;
    }
    if (!authOk) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST" || message === null) {
      response.writeHead(405);
      response.end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } }
        : message.method === "tools/list"
          ? { tools: Array.from({ length: options.tools ?? 2 }, (_, index) => ({ name: `stub_tool_${index}`, description: "A stub tool", inputSchema: { type: "object", properties: {} } })) }
          : {};
    const answer = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    const headers: Record<string, string> = message.method === "initialize" ? { "mcp-session-id": "stub-session-1" } : {};
    if (options.mode === "sse") {
      response.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`event: message\ndata: ${answer}\n\n`);
      // Keep the stream open, as some servers do: the client must stop reading after its answer.
      setTimeout(() => response.end(), 2_000).unref();
      return;
    }
    response.writeHead(200, { ...headers, "content-type": "application/json" });
    response.end(answer);
  };
  const server: Server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/mcp`,
    requests,
    options,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
