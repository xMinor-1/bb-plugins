// `::meeting-proposal{id="p_…"}` in an agent's reply: the proposed meeting,
// change, cancellation or answer with its Confirm button, right in the thread.
// The id is untrusted text from the message; the card only shows a proposal
// this machine actually holds for this thread.
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useMessages } from "@/lib/i18n";
import type { rpcContract } from "../../server";
import { MeetingCard } from "./MeetingCard";
import { meetingTexts } from "./meeting-messages";
import { Notice } from "./ui";

const PROPOSAL_ID = /^p_[0-9a-f]{12}$/;

export function MeetingDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const t = useMessages(meetingTexts);
  const id = attributes.id ?? "";
  if (!PROPOSAL_ID.test(id)) return <Notice tone="error">{t.brokenLink}</Notice>;
  return (
    <div className="my-2">
      <MeetingCard rpc={rpc} target={{ threadId: message.threadId }} id={id} />
    </div>
  );
}
