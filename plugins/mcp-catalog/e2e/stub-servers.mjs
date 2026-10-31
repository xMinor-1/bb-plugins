// Stubs for the end-to-end check, on one port:
//   GET  /api/server-templates   the catalog (no sign-in)
//   POST /u/1/<server>/mcp       a Streamable HTTP MCP server per name; tokens from STUB_TOKENS="name=token,…"
// The log says whether the token matched, never the token itself.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 7900);
const tokens = Object.fromEntries((process.env.STUB_TOKENS || "").split(",").filter(Boolean).map((pair) => pair.split("=")));
const templates = [
  { id: "wiki", name: "Wiki", description: "Search and read the company wiki." },
  { id: "tracker", name: "Tracker", description: "Read and create tasks in the issue tracker.", category: "Work" },
  { id: "gitlab", name: "GitLab", description: "Merge requests, pipelines and code search." },
];

createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const url = new URL(request.url, "http://stub");
    if (url.pathname === "/api/server-templates") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(templates));
      return;
    }
    const match = /^\/u\/1\/([\w-]+)\/mcp$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    const name = match[1];
    const expected = tokens[name];
    const authOk = expected !== undefined && request.headers.authorization === `Bearer ${expected}`;
    let message = null;
    try {
      message = body ? JSON.parse(body) : null;
    } catch {}
    console.log(JSON.stringify({ at: new Date().toISOString(), server: name, method: request.method, rpc: message?.method ?? null, authOk, ua: request.headers["user-agent"] ?? null }));
    if (!authOk) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    if (request.method === "DELETE" || request.method === "GET") {
      response.writeHead(request.method === "DELETE" ? 204 : 405);
      response.end();
      return;
    }
    if (!message || message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `stub-${name}`, version: "1.0.0" } }
        : message.method === "tools/list"
          ? { tools: [{ name: `${name}_search`, description: "Search", inputSchema: { type: "object", properties: {} } }, { name: `${name}_read`, description: "Read", inputSchema: { type: "object", properties: {} } }] }
          : {};
    response.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": `s-${name}` } : {}) });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
}).listen(port, "127.0.0.1", () => console.log(`stubs on ${port}`));
