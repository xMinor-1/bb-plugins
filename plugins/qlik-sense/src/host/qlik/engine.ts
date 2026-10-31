// JSON-RPC to the Qlik associative engine (Engine API) over a WebSocket.
import WebSocket from "ws";

/** The engine speaks loosely typed JSON; callers narrow what they read. */
export type EngineValue = any;

export class AuthError extends Error {}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The socket dropped mid-call: the call can be repeated on a new connection. */
export class DisconnectError extends Error {}

const FATAL: Record<string, string> = {
  OnLicenseAccessDenied: "Qlik: this account has no license to access the engine",
  OnNoEngineAvailable: "Qlik: no engine is available",
  OnMaxParallelSessionsExceeded: "Qlik: too many parallel sessions for this account",
  OnEngineWebsocketFailed: "Qlik: the proxy could not reach the engine",
};

const CALL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(value: EngineValue): void;
  reject(error: Error): void;
}

export class Connection {
  #ws: WebSocket | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  closed = false;

  static async open(url: string, headers: Record<string, string>): Promise<Connection> {
    const connection = new Connection();
    await connection.#open(url, headers);
    return connection;
  }

  #open(url: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const origin = new URL(url.replace(/^ws/, "http")).origin;
      const ws = new WebSocket(url, { headers, origin, handshakeTimeout: CONNECT_TIMEOUT_MS });
      this.#ws = ws;
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      // The engine greets with OnConnected; a proxy without a session sends
      // OnAuthenticationInformation instead. Some engines send neither.
      const timer = setTimeout(() => done(), 5_000);

      ws.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        done(
          [301, 302, 401, 403].includes(status)
            ? new AuthError(`Qlik refused the session (HTTP ${status})`)
            : new EngineError(`Qlik answered HTTP ${status} to the engine connection`),
        );
      });
      ws.on("error", (error) => done(new EngineError(`Cannot connect to Qlik: ${error.message}`)));
      ws.on("close", () => {
        this.closed = true;
        done(new DisconnectError("Qlik closed the connection"));
        for (const pending of this.#pending.values()) pending.reject(new DisconnectError("The Qlik connection is closed"));
        this.#pending.clear();
      });
      ws.on("message", (data) => {
        let message: EngineValue;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.id !== undefined && this.#pending.has(message.id)) {
          const pending = this.#pending.get(message.id)!;
          this.#pending.delete(message.id);
          if (message.error) {
            const detail = message.error.parameter ? `: ${message.error.parameter}` : "";
            pending.reject(new EngineError(`${message.error.message}${detail}`, message.error.code));
          } else {
            pending.resolve(message.result ?? {});
          }
          return;
        }
        if (message.method === "OnConnected") {
          done();
        } else if (message.method === "OnAuthenticationInformation" && message.params?.mustAuthenticate) {
          done(new AuthError("Qlik asks to sign in again"));
          ws.close();
        } else if (FATAL[message.method]) {
          done(new EngineError(FATAL[message.method]!));
          ws.close();
        }
      });
    });
  }

  call(handle: number, method: string, params: Record<string, unknown> = {}): Promise<EngineValue> {
    if (this.closed || this.#ws === null) return Promise.reject(new DisconnectError("The Qlik connection is closed"));
    const id = this.#nextId++;
    const ws = this.#ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EngineError(`Qlik did not answer ${method} within ${CALL_TIMEOUT_MS / 1000} s`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, handle, method, params }));
    });
  }

  close(): void {
    this.#ws?.close();
  }
}
