// bb-plugin-context-compact — backend entry.
//
// One RPC method. The frontend calls it when the user clicks the composer's
// context ring; it asks BB to compact that thread's context, the same request
// `bb thread compact <id>` makes. BB refuses the request while the thread is
// running, and that refusal travels back to the click as a toast.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  compact: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async compact({ threadId }) {
      await bb.sdk.threads.compact({ threadId });
      bb.log.info(`compaction requested for ${threadId}`);
      return { ok: true } as const;
    },
  });
}
