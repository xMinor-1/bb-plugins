// The `bb.host` entry. It runs on the machine where agents run — the machine
// that can reach Qlik Sense (often only inside a corporate network or VPN) and
// that keeps the password in its own OS store. The server entry never sees the
// password or Qlik data except tool answers on their way to an approved agent.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { QlikService } from "./host/service.js";

let service: QlikService | null = null;

function serviceFor(dataDir: string, lifecycle: AbortSignal): QlikService {
  if (!service) {
    const created = new QlikService({ dataDir });
    service = created;
    lifecycle.addEventListener(
      "abort",
      () => {
        created.close();
        if (service === created) service = null;
      },
      { once: true },
    );
  }
  return service;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: (_input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).status(),
    saveConnection: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).saveConnection(input),
    forget: (_input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).forget(),
    checkSignIn: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).checkSignIn(input.retry ?? false),
    listApps: async (_input, ctx) => ({ apps: await serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).listApps() }),
    listSheets: async (input, ctx) => ({
      sheets: await serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).listSheets(input.appId),
    }),
    getCatalog: (_input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).getCatalog(),
    saveCatalog: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).saveCatalog(input),
    checkLink: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).checkLink(input.link),
    tool: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).tool(input),
  },
  dispose: async () => {
    service?.close();
    service = null;
  },
});
