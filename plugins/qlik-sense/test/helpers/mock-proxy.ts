// A stand-in for the Qlik Sense proxy with forms sign-in: redirects to
// internal_forms_authentication, sets X-Qlik-Session after a correct POST, and
// relays engine WebSockets only for live sessions.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

const FORM = (error = "") => `<!DOCTYPE html><html><body>
<form id="loginForm" method="post" action="/internal_forms_authentication/">
${error ? `<div class="error">${error}</div>` : ""}
<input id="username-input" type="text" name="username" placeholder="Domain\\user">
<input id="password-input" type="password" name="pwd">
<button type="submit">Log in</button>
</form></body></html>`;

export interface MockProxy {
  url: string;
  stats: { logins: number; failedLogins: number; sockets: number };
  expire(): Promise<unknown>;
  close(): void;
}

export function startMockProxy({ engineUrl, user, password }: { engineUrl: string | null; user: string; password: string }): Promise<MockProxy> {
  const sessions = new Set<string>();
  const targets = new Map<string, string>();
  const sockets = new Set<WebSocket>();
  const stats = { logins: 0, failedLogins: 0, sockets: 0 };

  const sessionOf = (request: http.IncomingMessage) => request.headers.cookie?.match(/X-Qlik-Session=([^;]+)/)?.[1];
  const authed = (request: http.IncomingMessage) => {
    const session = sessionOf(request);
    return session !== undefined && sessions.has(session);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/__expire") {
      sessions.clear();
      for (const socket of sockets) socket.close();
      return void response.end("ok");
    }
    if (url.pathname.startsWith("/internal_forms_authentication")) {
      const target = targets.get(url.searchParams.get("targetId") ?? "");
      if (!target) {
        return void response
          .writeHead(400, { "content-type": "text/html" })
          .end("<html><body><h1>400 BadRequest: Virtual proxy not possible to determine, since neither TargetId nor Virtual Proxy were specified</h1></body></html>");
      }
      if (request.method === "GET") return void response.writeHead(200, { "content-type": "text/html" }).end(FORM());
      if (request.method !== "POST") return void response.writeHead(405).end();
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("username") !== user || form.get("pwd") !== password) {
          stats.failedLogins++;
          return void response.writeHead(200, { "content-type": "text/html" }).end(FORM("Invalid user name or password"));
        }
        stats.logins++;
        const session = randomUUID();
        sessions.add(session);
        response.writeHead(302, { location: target, "set-cookie": `X-Qlik-Session=${session}; Path=/; HttpOnly` }).end();
      });
      return;
    }
    if (request.method !== "GET") {
      // Like the real proxy: the sign-in round trip starts only from a GET.
      return void response.writeHead(403, 'The initial authentication request must be a "GET" request').end();
    }
    if (!authed(request)) {
      const id = randomUUID();
      targets.set(id, url.pathname);
      return void response.writeHead(302, { location: `/internal_forms_authentication/?targetId=${id}` }).end();
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<html>hub</html>");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!authed(request) || !engineUrl) {
      socket.end("HTTP/1.1 302 Found\r\nLocation: /internal_forms_authentication/\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      stats.sockets++;
      sockets.add(client);
      const upstream = new WebSocket(`${engineUrl}${request.url}`);
      const queue: string[] = [];
      upstream.on("open", () => queue.splice(0).forEach((message) => upstream.send(message)));
      upstream.on("message", (message) => client.send(message.toString()));
      client.on("message", (message) => (upstream.readyState === WebSocket.OPEN ? upstream.send(message.toString()) : queue.push(message.toString())));
      client.on("close", () => {
        sockets.delete(client);
        upstream.close();
      });
      upstream.on("close", () => client.close());
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stats,
        expire: () => fetch(`http://127.0.0.1:${port}/__expire`),
        close: () => {
          for (const socket of sockets) socket.terminate();
          wss.close();
          server.close();
        },
      });
    }),
  );
}
