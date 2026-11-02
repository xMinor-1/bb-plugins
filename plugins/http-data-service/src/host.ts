// The `bb.host` entry. It runs on the machine where agents run — the machine that
// can reach the service (often only inside a corporate network or VPN) and that
// keeps the password in its own OS store. The server entry never sees the password
// after it is saved, and sees answers only on their way to an approved agent.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { DataService } from "./host/service.js";

let service: DataService | null = null;

function serviceFor(dataDir: string): DataService {
  service ??= new DataService({ dataDir });
  return service;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).status(input.baseUrl),
    saveConnection: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).saveConnection(input),
    forget: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).forget(input.baseUrl),
    checkSignIn: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).checkSignIn(input),
    request: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).request(input, ctx.lifecycle.signal),
  },
  dispose: async () => {
    service = null;
  },
});
