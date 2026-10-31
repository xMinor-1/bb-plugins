// The dictation bar: a microphone, a text field, and a live view of what was
// heard. The board uses it for new tasks and commands, an open card for notes,
// agent requests and commands on that card. The hotkey (hooks/dictation.ts)
// drives whichever bar is active.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { messagesNow, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { registerDictationTarget } from "../hooks/dictation";
import { useRecorder, type RecorderError } from "../hooks/useRecorder";
import { messages } from "../src/messages";
import type { Span } from "../src/model";
import { Icon } from "./icons";

/** bb's voice service takes up to about 70 seconds. */
const MAX_SECONDS = 65;
/** How long the understood phrase stays highlighted. */
const SHOW_MS = 2600;

type Phase =
  | { type: "idle" }
  | { type: "busy"; text: string }
  | { type: "shown"; text: string; spans: Span[] };

export interface CaptureBarProps {
  variant: "board" | "composer";
  placeholder: string;
  /** Status shown while `onText` runs, picked from the phrase. */
  busyLabel: (text: string) => string;
  /** Whether the hotkey drives this bar now. */
  hotkeyTarget: boolean;
  /** Shown as a hint on the board bar; null hides it. */
  hotkeyLabel: string | null;
  /** Runs the phrase; resolves to spans to highlight, or null. Throws on failure. */
  onText: (text: string, spoken: boolean) => Promise<Span[] | null>;
}

const SPAN_CLASS: Record<Span["kind"], string> = {
  when: "k-when",
  importance: "k-imp",
  work: "k-work",
  link: "k-link",
  action: "k-act",
  target: "k-target",
};

function Highlighted({ text, spans }: { text: string; spans: Span[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, span] of [...spans].sort((a, b) => a.start - b.start).entries()) {
    if (span.start < at || span.end > text.length) continue;
    if (span.start > at) parts.push(text.slice(at, span.start));
    parts.push(
      <span key={i} className={cn("sn-sx", SPAN_CLASS[span.kind])}>
        {text.slice(span.start, span.end)}
      </span>,
    );
    at = span.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function CaptureBar({ variant, placeholder, busyLabel, hotkeyTarget, hotkeyLabel, onText }: CaptureBarProps) {
  const m = useMessages(messages);
  const [phase, setPhase] = useState<Phase>({ type: "idle" });
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shownTimer = useRef<number | undefined>(undefined);

  const run = async (text: string, spoken: boolean) => {
    window.clearTimeout(shownTimer.current);
    setPhase({ type: "busy", text });
    try {
      const spans = await onText(text, spoken);
      if (!spoken) setValue("");
      setPhase({ type: "shown", text, spans: spans ?? [] });
      shownTimer.current = window.setTimeout(() => setPhase({ type: "idle" }), SHOW_MS);
    } catch (cause) {
      setPhase({ type: "idle" });
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(messagesNow(messages).error(message));
    }
  };

  const onError = (error: RecorderError, detail?: string) => {
    const t = messagesNow(messages);
    const text = {
      "mic-denied": t.micDenied,
      "not-configured": t.noVoice,
      empty: t.heardNothing,
      failed: t.error(detail ?? ""),
    }[error];
    if (error === "empty") toast(text);
    else toast.error(text);
  };

  const recorder = useRecorder((text) => void run(text, true), onError);
  const { state, start, stop, cancel } = recorder;
  const recording = state === "recording";
  const busy = state === "transcribing" || phase.type === "busy";

  // bb's voice service caps a recording; stop a little before it.
  useEffect(() => {
    if (recording && recorder.seconds >= MAX_SECONDS) stop();
  }, [recording, recorder.seconds, stop]);

  useEffect(() => () => window.clearTimeout(shownTimer.current), []);

  // The hotkey toggles: start, then stop and add. Escape drops a recording.
  const live = useRef({ state, busy, start, stop });
  live.current = { state, busy, start, stop };
  useEffect(() => {
    if (!hotkeyTarget) return;
    return registerDictationTarget({
      toggle: () => {
        const { state: now, busy: working } = live.current;
        if (now === "recording") live.current.stop();
        else if (now === "idle" && !working) void live.current.start();
      },
    });
  }, [hotkeyTarget]);
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, cancel]);

  const dataState = recording ? "rec" : busy ? "parse" : phase.type === "shown" ? "shown" : "idle";
  const seconds = recorder.seconds;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const statusText = state !== "transcribing" && phase.type === "busy" ? busyLabel(phase.text) : null;

  return (
    <div className={cn("sn-capture", variant === "composer" && "cmp")} data-state={dataState}>
      <button
        type="button"
        className="sn-mic"
        aria-label={recording ? m.micStop : m.micStart}
        title={recording ? m.micStop : m.micStart}
        disabled={busy}
        onClick={() => (recording ? stop() : void start())}
      >
        <Icon name={recording ? "stop" : "mic"} size={variant === "composer" ? 18 : 20} />
      </button>

      <div className="sn-cap-body">
        {recording ? (
          <div className="sn-cap-live">
            <span className="sn-wave" aria-hidden="true">
              {recorder.levels.map((level, i) => (
                <i key={i} style={{ transform: `scaleY(${0.18 + level * 0.82})` }} />
              ))}
            </span>
            <span className="sn-cap-status">{m.listening}</span>
          </div>
        ) : state === "transcribing" ? (
          <div className="sn-cap-live">
            <span className="sn-cap-status">{m.transcribing}</span>
          </div>
        ) : phase.type === "busy" || phase.type === "shown" ? (
          <div className="sn-cap-live" aria-live="polite">
            <span className="sn-tr">
              {phase.type === "shown" ? <Highlighted text={phase.text} spans={phase.spans} /> : phase.text}
            </span>
          </div>
        ) : (
          <input
            ref={inputRef}
            className="sn-cap-input"
            value={value}
            placeholder={placeholder}
            aria-label={variant === "board" ? m.newTask : m.composer}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                const text = value.trim();
                if (text) {
                  event.preventDefault();
                  void run(text, false);
                }
              } else if (event.key === "Escape" && value) {
                event.stopPropagation();
                setValue("");
              }
            }}
          />
        )}
      </div>

      <div className="sn-cap-side">
        {recording ? (
          <>
            <span className="sn-timer">{clock}</span>
            <button type="button" className="sn-btn sm ghost" onClick={cancel}>
              {m.cancel}
            </button>
            <button type="button" className="sn-btn sm" onClick={stop}>
              {m.stop}
            </button>
          </>
        ) : statusText ? (
          <span className="sn-cap-status">{statusText}</span>
        ) : variant === "board" && phase.type === "idle" && hotkeyLabel ? (
          <span className="sn-hold">
            {m.pressBefore} <kbd>{hotkeyLabel}</kbd> {m.pressAfter}
          </span>
        ) : null}
      </div>
    </div>
  );
}
