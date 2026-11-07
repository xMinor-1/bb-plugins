// The `bb.host` entry: runs on the person's machine, keeps their API key in the OS store and sends the report with it.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract";
import { ReportHost } from "./host/service";

let service: ReportHost | null = null;
const serviceFor = (dataDir: string) => (service ??= new ReportHost({ dataDir }));

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).status(input.baseUrl, input.shareWith),
    saveKey: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).saveKey(input.baseUrl, input.shareWith, input.key),
    forget: (input, ctx) => serviceFor(ctx.experimental_paths.dataDir).forget(input.baseUrl, input.shareWith),
    postJson: (input, ctx) =>
      serviceFor(ctx.experimental_paths.dataDir).post({ ...input, body: input.body, type: "application/json" }, ctx.lifecycle.signal),
    postFile: (input, ctx) => {
      const form = new FormData();
      const bytes = new Uint8Array(Buffer.from(input.file.base64, "base64"));
      form.append(input.field, new Blob([bytes], { type: input.file.type }), input.file.name);
      // No Content-Type: fetch sets multipart/form-data with its boundary.
      return serviceFor(ctx.experimental_paths.dataDir).post({ ...input, body: form, type: null }, ctx.lifecycle.signal);
    },
  },
  dispose: async () => {
    service = null;
  },
});
