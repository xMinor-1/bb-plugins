// `::mail-draft{id="d_…"}` in an agent's reply: the draft with its Send button,
// right in the thread. The id is untrusted text from the message; the card
// only shows a draft this machine actually holds for this thread's mailbox.
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { DraftCard } from "./DraftCard";
import { Notice } from "./ui";

const DRAFT_ID = /^d_[0-9a-f]{12}$/;

export function DraftDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const id = attributes.id ?? "";
  if (!DRAFT_ID.test(id)) return <Notice tone="error">This mail draft link is broken.</Notice>;
  return (
    <div className="my-2">
      <DraftCard rpc={rpc} target={{ threadId: message.threadId }} id={id} />
    </div>
  );
}
