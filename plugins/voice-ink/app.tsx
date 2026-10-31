// voice-ink's own microphone button, mounted in bb's composer.
//
// bb's built-in button records the whole phrase, then waits for recognition.
// This one sends speech to the local model in pieces while you talk, so after
// "stop" only the last piece is still being recognized.
import { useCallback, useEffect } from "react";
import {
  definePluginApp,
  useComposer,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { ConversationButton } from "@/components/ConversationButton";
import { HistoryDisclosure } from "@/components/HistoryDisclosure";
import { HistoryPanel } from "@/components/HistoryPanel";
import { Icon } from "@/components/ui/icon";
import { useDictation } from "@/hooks/useDictation";
import { defineMessages, getLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { PANEL_PATH } from "./contract";
import type { rpcContract } from "./server";

const messages = defineMessages(
  {
    dictationFailed: "Dictation failed",
    stop: "Stop dictation (Esc cancels)",
    finishing: "Finishing transcription",
    dictate: "Dictate with the local model",
    historyLabel: "Voice Ink history",
  },
  {
    dictationFailed: "Не удалось надиктовать",
    stop: "Остановить диктовку (Esc — отменить)",
    finishing: "Дораспознаю последний кусок",
    dictate: "Диктовать локальной моделью",
    historyLabel: "История Voice Ink",
  },
);

function VoiceButton() {
  const t = useMessages(messages);
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();

  // A phrase goes to the end of the draft after one space. Mentions and
  // attachments stay: only trailing whitespace is replaced, and no pill
  // reaches into it.
  const appendText = useCallback(
    (text: string) => {
      composer.replace((current) => {
        const head = current.text.replace(/\s+$/, "");
        if (head === "") return { text, mentions: [] };
        return {
          text: `${head} ${text}`,
          mentions: current.mentions.filter((mention) => mention.to <= head.length),
        };
      });
    },
    [composer],
  );

  const { status, level, pending, start, stop, cancel } = useDictation({
    transcribe: (input) =>
      rpc.call("transcribe_segment", { ...input, language: null }),
    onText: appendText,
    onError: (message) => {
      toast.error(t.dictationFailed, { description: message });
    },
    warmUp: () => {
      // Loading the model takes seconds; starting it with the recording means
      // the first phrase waits for recognition, not for the model.
      void rpc.call("status", { warmUp: true }).catch(() => {});
    },
  });

  const listening = status === "listening";
  const busy = status === "finishing" || pending > 0;

  // Escape drops what was dictated but not yet sent — the usual way out of a
  // recording you did not mean to start.
  useEffect(() => {
    if (!listening) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, listening]);

  // bb's own microphone button already reaches every client, including the
  // phone app, so a second button in the composer is opt-in.
  if (settings.values?.composerButton !== true) return null;

  const label = listening ? t.stop : busy ? t.finishing : t.dictate;

  return (
    <button
      aria-label={label}
      aria-pressed={listening}
      className={cn(
        "relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        listening && "text-destructive hover:text-destructive",
        busy && !listening && "text-foreground",
      )}
      disabled={composer.isSubmitting}
      onClick={() => {
        void (listening ? stop() : start());
      }}
      title={label}
      type="button"
    >
      {listening ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-md bg-destructive/15"
          style={{ transform: `scale(${(0.75 + level * 0.5).toFixed(2)})` }}
        />
      ) : null}
      <Icon
        aria-hidden
        className={cn("relative size-4", busy && !listening && "animate-spin")}
        name={busy && !listening ? "Loading" : "Mic"}
      />
      {pending > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
      ) : null}
    </button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "voice-ink",
    actions: [
      { id: "dictate", component: VoiceButton },
      { id: "converse", component: ConversationButton },
    ],
  });

  // Dictations outlive the composer they were meant for: bb stops waiting
  // after seventy seconds, recognition does not. This is where the whole text
  // and the recording it came from can be found afterwards.
  app.slots.navPanel({
    id: "voice-ink",
    title: "Voice Ink",
    icon: "Mic",
    path: PANEL_PATH,
    component: HistoryPanel,
  });

  // Registered once at load: a language switch shows up here after a reload.
  //
  // The microphone in the sidebar footer, next to settings and the theme
  // switch: the sidebar row above can be folded away under "More", and the
  // question this answers ("did all of it get through?") comes up right after
  // speaking, not when browsing panels.
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "history",
    label: messages[getLang()].historyLabel,
    icon: "Mic",
    component: HistoryDisclosure,
  });
});
