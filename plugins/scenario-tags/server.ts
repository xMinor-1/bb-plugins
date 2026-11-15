// Scenario Tags — server side.
//
// It holds the scenario catalog setting (one JSON string, usually written by
// a build manifest), the person's own pinned tags, and a CLI command that
// checks the catalog. The tags, the form and the inserted prompt live in
// app.tsx; nothing here talks to agents.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_CATALOG_CHARS, parseCatalog, pinnedScenarios, type OwnPins } from "./src/catalog";
import { MAX_PINS, PINS_CHANGED } from "./src/shared";

const scenarioId = z.string().min(1).max(64);
const ownPinsSchema = z.object({
  pins: z.array(scenarioId).max(MAX_PINS),
  known: z.array(scenarioId).max(500),
});

export const rpcContract = defineRpcContract({
  pins_get: {
    input: z.null(),
    output: z.object({ own: ownPinsSchema.nullable() }),
  },
  /** `null` returns to the catalog's own pick. */
  pins_set: {
    input: z.object({ own: ownPinsSchema.nullable() }),
    output: z.object({ own: ownPinsSchema.nullable() }),
  },
});
export type RpcContract = typeof rpcContract;

const PINS_KEY = "pins";

export const CATALOG_HELP =
  "The tags above the message box, as JSON: `{ \"groups\": [{ \"id\", \"label\" }], \"scenarios\": [{ \"id\", \"label\", \"group\", \"pinned\", \"fields\": [{ \"id\", \"label\", \"type\": \"text\" | \"textarea\" | \"select\" | \"attachment\", \"required\" }], \"prompt\" }] }`. " +
  "In `prompt`, `{{field}}` takes an answer and `{{answers}}` lists the others; a line whose answers are all empty is left out. " +
  "Run `bb scenario-tags check` after a change. A build manifest usually writes this setting.";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    scenarios: {
      type: "string",
      label: "Scenario catalog",
      description: CATALOG_HELP,
      experimental_multiline: true,
      experimental_schema: {
        "~standard": {
          version: 1,
          vendor: "scenario-tags",
          validate: (value: unknown) =>
            typeof value === "string" && value.length <= MAX_CATALOG_CHARS
              ? { value }
              : { issues: [{ message: `Up to ${MAX_CATALOG_CHARS} characters of JSON` }] },
        },
      },
      default: "",
    },
  });

  async function readPins(): Promise<OwnPins | null> {
    const parsed = ownPinsSchema.safeParse(await bb.storage.kv.get(PINS_KEY));
    return parsed.success ? parsed.data : null;
  }

  bb.rpc.register(rpcContract, {
    pins_get: async () => ({ own: await readPins() }),
    pins_set: async ({ own }) => {
      if (own === null) await bb.storage.kv.delete(PINS_KEY);
      else await bb.storage.kv.set(PINS_KEY, own);
      bb.realtime.publish(PINS_CHANGED, {});
      return { own };
    },
  });

  const usage = [
    "Usage:",
    "  bb scenario-tags check [--json]   Check the scenario catalog setting and list what the tags show",
    "  bb scenario-tags reset-pins       Return the collapsed row to the catalog's own pick",
  ].join("\n");

  bb.cli.register({
    name: "scenario-tags",
    summary: "Check the scenario catalog behind the tags above the message box",
    commands: [
      { name: "check", summary: "Check the scenario catalog", usage: "bb scenario-tags check [--json]" },
      { name: "reset-pins", summary: "Drop the person's own pinned tags", usage: "bb scenario-tags reset-pins" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
      if (command === "check") {
        const { scenarios: raw } = await settings.get();
        const catalog = parseCatalog(raw);
        const own = await readPins();
        const row = pinnedScenarios(catalog, own).map((scenario) => scenario.id);
        const exitCode = catalog.problems.length > 0 ? 1 : 0;
        if (json) {
          return {
            exitCode,
            stdout: JSON.stringify({
              scenarios: catalog.scenarios.map(({ id, label, group }) => ({ id, label, group: group ?? null })),
              row,
              ownPins: own !== null,
              problems: catalog.problems,
            }),
          };
        }
        const lines = [
          catalog.scenarios.length === 0
            ? "The catalog is empty: no tags show."
            : `${catalog.scenarios.length} scenario(s) in ${catalog.groups.length} group(s).`,
          ...catalog.scenarios.map((s) => `  ${s.id}  ${s.label}${s.group ? `  [${s.group}]` : ""}${row.includes(s.id) ? "  (in the row)" : ""}`),
          own !== null ? "The person pinned their own tags." : "The row shows the catalog's pinned tags.",
          ...catalog.problems.slice(0, 20).map((problem) => `Problem: ${problem}`),
        ];
        return { exitCode, stdout: lines.join("\n") };
      }
      if (command === "reset-pins") {
        await bb.storage.kv.delete(PINS_KEY);
        bb.realtime.publish(PINS_CHANGED, {});
        return { exitCode: 0, stdout: "The row shows the catalog's pinned tags again." };
      }
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      return { exitCode: 1, stderr: usage };
    },
  });
}
