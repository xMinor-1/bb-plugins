// The `bb.host` entry: runs on each machine bb reaches — a laptop connected to
// a remote bb server included — and reads OpenCode's database there. Only sums
// per model go back to the server.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract";
import { readOpencodeUsage } from "./opencode/reader";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readOpencode: ({ now }) => readOpencodeUsage({ now }),
  },
});
