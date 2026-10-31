// The `bb.host` entry. It runs on the person's machine — the one where the
// agent runs and that reaches the company's MCP servers. It keeps the server
// list and tokens there (src/host/service.ts); the server entry stores none.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { McpService } from "./host/service.js";

let service: McpService | null = null;

function serviceFor(dataDir: string): McpService {
  service ??= new McpService({ dataDir });
  return service;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: (_input, ctx) => serviceFor(ctx.experimental_paths.dataDir).status(),
    importConfig: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).importConfig(input.text, input.config),
    setEnabled: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).setEnabled(input.name, input.enabled, input.replace === true, input.config),
    setTimeout: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).setTimeout(input.name, input.timeoutSec, input.config),
    remove: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).remove(input.name, input.config),
    check: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).check(input.names, input.maxAgeMs ?? 0, input.config, ctx.signal),
    sync: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).sync(input.config),
    catalog: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).catalog(input.url, input.refresh === true, input.allowHttp === true),
  },
  dispose: () => {
    service = null;
  },
});
