// Installs a package with Fleet Kit's own code (src/host/install-app.ts): cuts the file into 90 MB parts, as a file
// server with an upload limit would serve it, serves them from 127.0.0.1 and calls ensureApp. Prints the outcome as
// JSON and exits 0 only when the program is installed.
//
//   node --experimental-transform-types try-install.mjs <install-app.ts> <package> <zip|dmg> <program> <directory> [result file]
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [fleet, pkg, format, program, directory, resultFile] = process.argv.slice(2);
if (!directory) {
  console.error("usage: node try-install.mjs <install-app.ts> <package> <zip|dmg> <program> <directory>");
  process.exit(2);
}
const PART = 94_371_840;
const size = statSync(pkg).size;
const parts = [];
const fd = openSync(pkg, "r");
const whole = createHash("sha256");
for (let offset = 0; offset < size; offset += PART) {
  const buffer = Buffer.alloc(Math.min(PART, size - offset));
  readSync(fd, buffer, 0, buffer.length, offset);
  whole.update(buffer);
  parts.push({ offset, length: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") });
}
closeSync(fd);

const server = createServer((request, response) => {
  const index = Number(new URL(request.url, "http://x").pathname.slice(1));
  const part = parts[index];
  if (part === undefined) {
    response.writeHead(404).end();
    return;
  }
  const buffer = Buffer.alloc(part.length);
  const file = openSync(pkg, "r");
  readSync(file, buffer, 0, part.length, part.offset);
  closeSync(file);
  response.writeHead(200, { "content-length": String(part.length) }).end(buffer);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { ensureApp } = await import(pathToFileURL(fleet).href);
const started = Date.now();
const outcome = await ensureApp({
  directory,
  version: "test",
  file: { format, parts: parts.map((part, index) => ({ url: `${base}/${index}`, sha256: part.sha256 })), sha256: whole.digest("hex"), program },
  signal: new AbortController().signal,
});
server.close();
const result = JSON.stringify({ ...outcome, parts: parts.length, seconds: Math.round((Date.now() - started) / 1000) });
console.log(result);
// Also as a UTF-8 file: Windows PowerShell 5.1 reads console output in the OEM code page, which breaks non-ASCII paths.
if (resultFile) writeFileSync(resultFile, result, "utf8");
process.exit(outcome.state === "installed" ? 0 : 1);
