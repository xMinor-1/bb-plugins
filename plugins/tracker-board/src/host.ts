// The `bb.host` entry. It runs on the machine where agents run — the machine that
// can reach the tracker (often only inside a corporate network) and that keeps the
// API key in its own OS store. The server entry never sees the key after it is saved.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { TrackerHost } from "./host/service.js";

let service: TrackerHost | null = null;

function serviceFor(dataDir: string): TrackerHost {
  service ??= new TrackerHost({ dataDir });
  return service;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).status(input.baseUrl),
    saveKey: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).saveKey(input),
    forget: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).forget(input.baseUrl),
    recordCheck: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).recordCheck(input),
    request: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).request(input, ctx.lifecycle.signal),
  },
  dispose: async () => {
    service = null;
  },
});
