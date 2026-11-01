// The `bb.host` entry. It runs on the person's machine, where the browser signed in to the
// messenger lives. The server entry never stores messages; it passes answers on to the panel and
// to approved agents.
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { MessengerService } from "./host/service.js";

let service: MessengerService | null = null;

function serviceFor(ctx: ExperimentalHostRpcContext): MessengerService {
  if (!service) {
    const created = new MessengerService({ dataDir: ctx.experimental_paths.dataDir, retain: () => ctx.experimental_retainWorker() });
    service = created;
    ctx.lifecycle.signal.addEventListener(
      "abort",
      () => {
        created.dispose();
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
    status: ({ url }, ctx) => serviceFor(ctx).status(url),
    signIn: ({ url }, ctx) => serviceFor(ctx).signIn(url),
    sync: ({ url }, ctx) => serviceFor(ctx).sync(url),
    findChats: ({ url, query, limit }, ctx) => serviceFor(ctx).findChats(url, query, limit),
    chat: ({ url, id }, ctx) => serviceFor(ctx).chat(url, id),
    tool: ({ url, call }, ctx) => serviceFor(ctx).tool(url, call, ctx.signal),
    snapshot: ({ url, ids }, ctx) => serviceFor(ctx).snapshot(url, ids),
    close: (_input, ctx) => serviceFor(ctx).close(),
    forget: (_input, ctx) => serviceFor(ctx).forget(),
  },
  dispose: () => {
    service?.dispose();
    service = null;
  },
});
