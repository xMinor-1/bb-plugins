// Converts the samples to PDF with doc-review's own code (src/libreoffice.ts): the same lookup of the program by
// the path from its setting, the same private profile and the same arguments. Exits 0 when both PDFs are non-empty.
//
//   node --experimental-transform-types convert.mjs <libreoffice.ts> <soffice> <samples folder> <PDF folder>
import { mkdtempSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [code, soffice, docs, out] = process.argv.slice(2);
const { findLibreOffice, LibreOfficeRunner } = await import(pathToFileURL(code).href);
const install = await findLibreOffice(soffice);
console.log(JSON.stringify({ found: install }));
if (!install || !install.components.writer || !install.components.impress) process.exit(1);
const runner = new LibreOfficeRunner({ profileDir: mkdtempSync(join(tmpdir(), "lo-profile-")), timeoutMs: 300_000 });
let bad = 0;
for (const name of ["документ.docx", "слайды.pptx"]) {
  const outDir = join(out, name.replace(/\W/g, "_"));
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  try {
    const pdf = await runner.convert({ install, input: join(docs, name), outDir, format: "pdf" });
    const size = statSync(pdf).size;
    console.log(JSON.stringify({ name, pdf, size, seconds: Math.round((Date.now() - started) / 1000) }));
    if (size === 0) bad += 1;
  } catch (error) {
    bad += 1;
    console.log(JSON.stringify({ name, error: String(error), detail: error?.detail ?? "" }));
  }
}
runner.dispose();
process.exit(bad === 0 ? 0 : 1);
