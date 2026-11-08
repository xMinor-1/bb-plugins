// The `bb.host` entry: runs on the person's machine, keeps their API key in the OS store and sends the report with it.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract";
import { multipartBody, ReportHost } from "./host/service";

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
    // No Content-Type in either: fetch sets multipart/form-data with its boundary.
    postForm: (input, ctx) =>
      serviceFor(ctx.experimental_paths.dataDir).post({ ...input, body: multipartBody(input.fields, input.field, input.files), type: null }, ctx.lifecycle.signal),
    postFile: (input, ctx) =>
      serviceFor(ctx.experimental_paths.dataDir).post({ ...input, body: multipartBody({}, input.field, [input.file]), type: null }, ctx.lifecycle.signal),
  },
  dispose: async () => {
    service = null;
  },
});
