// An OpenAI-compatible gateway with three models that misbehave on purpose.
//
//   node fake-models.mjs [port]
//
//   ok       streams "Pong from ok"
//   limited  answers 429 Too Many Requests
//   slow     takes the request and never answers (a hung model)
//
// Each request is logged as one JSON line: time, model, what it got.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4010);
const models = ["ok", "limited", "slow"];
const hung = new Set();

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    } catch {
      body = null;
    }
    const model = body?.model ?? null;
    const log = (outcome) => console.log(JSON.stringify({ at: new Date().toISOString(), url: req.url, model, outcome }));
    if (req.method === "GET" && req.url?.replace(/\/$/, "") === "/v1/models") {
      log("list");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (model === "limited") {
      log("429");
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ error: { message: "Too Many Requests", type: "rate_limit_exceeded", code: "rate_limit" } }));
      return;
    }
    if (model === "slow") {
      log("hang");
      hung.add(res);
      res.on("close", () => {
        hung.delete(res);
        log("closed by client");
      });
      return;
    }
    log("pong");
    const created = Math.floor(Date.now() / 1000);
    if (body?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ id: "c1", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "Pong from ok" }, finish_reason: null }] });
      send({ id: "c1", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
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
        choices: [{ index: 0, message: { role: "assistant", content: "Pong from ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ listening: port })));
