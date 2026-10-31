// Plain-text answers for agents: Markdown tables, filter summaries, object trees.
import type { AppliedFilters, CubeData, ObjectInfo } from "./qlik/operations.js";

const cell = (value: unknown) =>
  String(value ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replaceAll("|", "\\|")
    .slice(0, 120);

export function table(columns: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join("\n");
}

export function filtersText({ selections, lost }: AppliedFilters): string {
  const lines = [`Filters: ${selections.length ? selections.map((s) => `${s.field} = ${s.text}`).join("; ") : "none"}`];
  if (lost.length) {
    lines.push(`Warning: Qlik dropped the filters ${lost.join(", ")} — no data matches them together with the others.`);
  }
  return lines.join("\n");
}

export function dataText(head: string, data: CubeData, applied: AppliedFilters): string {
  const shown = data.rows.length;
  const more = data.total > shown ? `, showing the first ${shown} (raise max_rows or narrow the filters)` : "";
  const parts = [head, filtersText(applied), `Rows: ${data.total}${more}`, ""];
  parts.push(shown ? table(data.columns, data.rows) : "No data.");
  if (data.totals) {
    const totals = data.columns.slice(data.nDims).map((column, i) => `${column} = ${data.totals![i]}`);
    parts.push("", `Totals: ${totals.join("; ")}`);
  }
  return parts.join("\n");
}

export function objectLine(object: ObjectInfo, indent = ""): string {
  const what: string[] = [];
  if (object.dimensions?.length) what.push(`dimensions: ${object.dimensions.join(", ")}`);
  if (object.measures?.length) what.push(`measures: ${object.measures.join(", ")}`);
  if (object.rows !== undefined && object.dimensions?.length) what.push(`rows: ${object.rows}`);
  if (object.field) what.push(`field: ${object.field}`);
  const title = object.title ? ` "${object.title}"` : "";
  const lines = [`${indent}- ${object.type}${title} [id: ${object.id}]${what.length ? ` — ${what.join("; ")}` : ""}`];
  for (const child of object.children ?? []) lines.push(objectLine(child, `${indent}  `));
  return lines.join("\n");
}
