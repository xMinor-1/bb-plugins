// A package registry in miniature for the download tests: the configured
// origin checks a token and redirects to storage on another origin (as a
// registry in front of object storage does), and the storage serves byte
// ranges and can drop the first connection half-way.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface DownloadServer {
  /** Base URL of the registry, e.g. http://127.0.0.1:1234/pkg/ */
  registry: string;
  /** Requests the storage saw: file, Range header, whether the token leaked to it. */
  storageLog: { name: string; range: string | null; leaked: boolean }[];
  close(): Promise<void>;
}

export const TOKEN_HEADER = "PRIVATE-TOKEN";
export const TOKEN = "t0ken";

export async function startDownloadServer(
  files: Record<string, Buffer>,
  options: {
    cutFirstAfterBytes?: number;
    /** Called when the first connection is cut: a test may change the files then. */
    afterCut?: () => void;
    /** Where the registry redirects instead of its storage, for a test of where redirects may go. */
    redirectTo?: string;
  } = {},
): Promise<DownloadServer> {
  const storageLog: DownloadServer["storageLog"] = [];
  let cutDone = false;

  const storage = createServer((request: IncomingMessage, response: ServerResponse) => {
    const name = decodeURIComponent((request.url ?? "").replace(/^\/blob\//, ""));
    const body = files[name];
    const range = request.headers.range ?? null;
    storageLog.push({ name, range, leaked: request.headers[TOKEN_HEADER.toLowerCase()] !== undefined });
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    let start = 0;
    const match = range === null ? null : /^bytes=(\d+)-$/.exec(range);
    if (match !== null) {
      start = Number(match[1]);
      if (start >= body.length) {
        response.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
        return;
      }
      response.writeHead(206, {
        "content-length": String(body.length - start),
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
      });
    } else {
      response.writeHead(200, { "content-length": String(body.length) });
    }
    const slice = body.subarray(start);
    if (options.cutFirstAfterBytes !== undefined && !cutDone && start === 0) {
      cutDone = true;
      response.write(slice.subarray(0, options.cutFirstAfterBytes), () => {
        setTimeout(() => {
          request.socket.destroy();
          options.afterCut?.();
        }, 20);
      });
      return;
    }
    response.end(slice);
  });
  await listen(storage, "localhost");
  const storagePort = (storage.address() as AddressInfo).port;

  const registry = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.headers[TOKEN_HEADER.toLowerCase()] !== TOKEN) {
      response.writeHead(401).end();
      return;
    }
    const name = (request.url ?? "").replace(/^\/pkg\//, "");
    // `localhost` is another origin than 127.0.0.1: the token must stay behind.
    response.writeHead(302, { location: options.redirectTo ?? `http://localhost:${storagePort}/blob/${name}` }).end();
  });
  await listen(registry, "127.0.0.1");
  const registryPort = (registry.address() as AddressInfo).port;

  return {
    registry: `http://127.0.0.1:${registryPort}/pkg/`,
    storageLog,
    close: async () => {
      await Promise.all([close(storage), close(registry)]);
    },
  };
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve) => server.listen(0, host, () => resolve()));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
