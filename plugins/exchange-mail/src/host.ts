// The `bb.host` entry. It runs on the person's machine — the one that can reach
// Exchange (often only inside the corporate network or VPN) and signs in as the
// person. The server entry never stores mail; it passes answers on to the panel
// and to approved agents.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { MailService } from "./host/service.js";

let service: MailService | null = null;

function serviceFor(dataDir: string, lifecycle: AbortSignal): MailService {
  if (!service) {
    const created = new MailService({ dataDir });
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
    check: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).check(input.retry ?? false, ctx.signal),
    list: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).list(input, ctx.signal),
    read: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).read(input.ref, input.markRead ?? false, ctx.signal),
    drafts: (_input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).drafts(ctx.signal),
    draft: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).draft(input.id, ctx.signal),
    saveDraft: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).saveDraft(input, ctx.signal),
    discardDraft: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).discardDraft(input.id, ctx.signal),
    send: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).send(input.id, input.revision, ctx.signal),
    tool: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir, ctx.lifecycle.signal).tool(input, ctx.signal),
  },
  dispose: async () => {
    service?.close();
    service = null;
  },
});
