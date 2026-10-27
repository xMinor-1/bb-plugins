// The conversation button in bb's composer: press once and talk; the phrase is
// sent when you pause and the reply is read aloud, then it listens again.
// Press again to end the conversation, Escape to cut a reply short.
import { useEffect, useRef, useState } from "react";
import { useBbContext, useComposer, useRpc, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  HeadphonesIcon,
  Loading03Icon,
  StopCircleIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Conversation, type ConversationStatus, type ReplyEvent } from "@/lib/conversation";
import { cn } from "@/lib/utils";
import type { ConversationTiming } from "@/contract";
import type { rpcContract } from "@/server";

/** An event page; bb serves at most a hundred rows per call. */
const PAGE = "100";

const LABELS: Record<ConversationStatus, string> = {
  off: "Talk with the agent (replies are read aloud)",
  listening: "Listening — pause to send, press to end the conversation",
  thinking: "Waiting for the reply — press to end the conversation",
  speaking: "Reading the reply — Esc skips it, press to end the conversation",
};

function describe(timing: ConversationTiming): string {
  const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  return (
    `Last reply: quick voice after ${seconds(timing.quickPlayingMs)}, ` +
    `agent after ${seconds(timing.playingMs)} (sent ${seconds(timing.submittedMs)})`
  );
}

export function ConversationButton() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const { threadId } = useBbContext();
  const settings = useSettings();
  const [status, setStatus] = useState<ConversationStatus>("off");
  const [level, setLevel] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const conversationRef = useRef<Conversation | null>(null);
  // The composer handle changes as the user types; the conversation outlives that.
  const composerRef = useRef(composer);
  composerRef.current = composer;

  // A conversation belongs to one thread: switching threads ends it.
  useEffect(() => {
    return () => {
      conversationRef.current?.stop();
      conversationRef.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    if (status !== "speaking") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      conversationRef.current?.skip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status]);

  if (settings.values?.conversationButton === false || threadId === null) return null;

  const toggle = () => {
    if (conversationRef.current !== null) {
      conversationRef.current.stop();
      conversationRef.current = null;
      return;
    }
    const conversation = new Conversation({
      threadId,
      config: () => rpc.call("conversation_config", {}),
      fillers: () => rpc.call("fillers", {}),
      quickReply: (text, recent) => rpc.call("quick_reply", { text, recent }),
      transcribe: (input) => rpc.call("transcribe_segment", { ...input, language: null }),
      speak: (text) => rpc.call("speak", { text }),
      submit: async (text) => {
        const current = composerRef.current;
        current.replace({ text, mentions: [] });
        await current.submit({ experimental_data: { source: "voice-ink-conversation" } });
      },
      latestSeq: async () => {
        const rows = await sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
        return rows[0]?.seq ?? 0;
      },
      eventsAfter: async (afterSeq) => {
        const rows = await sdk.threads.events.list({
          threadId,
          afterSeq: String(afterSeq),
          order: "asc",
          limit: PAGE,
          types: ["item/agentMessage/delta", "turn/completed"],
        });
        return rows as unknown as ReplyEvent[];
      },
      log: (entry) => {
        setLast(describe(entry));
        void rpc.call("conversation_log", { entry }).catch(() => {});
      },
      onStatus: setStatus,
      onLevel: setLevel,
      onError: (message) => toast.error("Conversation", { description: message }),
    });
    conversationRef.current = conversation;
    // Inside the click: browsers only let audio start from a user gesture.
    conversation.start();
  };

  const on = status !== "off";
  const label = last !== null && status !== "off" ? `${LABELS[status]}\n${last}` : LABELS[status];
  const icon =
    status === "speaking"
      ? VolumeHighIcon
      : status === "thinking"
        ? Loading03Icon
        : status === "listening"
          ? StopCircleIcon
          : HeadphonesIcon;

  return (
    <button
      aria-label={LABELS[status]}
      aria-pressed={on}
      className={cn(
        "relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        on && "text-primary hover:text-primary",
      )}
      onClick={toggle}
      title={label}
      type="button"
    >
      {status === "listening" ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-md bg-primary/15"
          style={{ transform: `scale(${(0.75 + level * 0.5).toFixed(2)})` }}
        />
      ) : null}
      <HugeiconsIcon
        aria-hidden
        className={cn("relative size-4", status === "thinking" && "animate-spin")}
        icon={icon}
        size={16}
      />
    </button>
  );
}
