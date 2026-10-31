// A tiny OpenAI-compatible gateway for end-to-end checks.
//
//   FAKE_GATEWAY_KEY_FILE=<file with the expected key> node fake-gateway.mjs [port]
//
// Answers every chat completion with "Pong" (streamed or not) and lists two
// models. Each request is logged as one JSON line with `auth` set to "ok",
// "bad" or "missing"; the key itself is never printed.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 4010);
const keyFile = process.env.FAKE_GATEWAY_KEY_FILE;

function expectedKey() {
  if (!keyFile) return null;
  try {
    return readFileSync(keyFile, "utf8").trim();
  } catch {
    return null;
  }
}

function authState(header) {
  if (typeof header !== "string" || header.length === 0) return "missing";
  const expected = expectedKey();
  return expected !== null && header === `Bearer ${expected}` ? "ok" : "bad";
}

const models = ["model-large", "model-small"];

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const auth = authState(req.headers.authorization);
    let body = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    } catch {
      body = null;
    }
    console.log(
      JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, auth, model: body?.model ?? null, stream: body?.stream ?? null }),
    );
    if (auth !== "ok") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key", type: "invalid_request_error" } }));
      return;
    }
    if (req.method === "GET" && req.url?.replace(/\/$/, "") === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const model = body?.model ?? models[0];
      const created = Math.floor(Date.now() / 1000);
      if (body?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        send({ id: "c1", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "Pong" }, finish_reason: null }] });
        send({ id: "c1", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "Pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ listening: port })));
