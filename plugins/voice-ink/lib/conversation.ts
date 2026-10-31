// Conversation mode: listen, send the phrase when the user pauses, read the
// agent's reply aloud while it is still being written, then listen again.
//
// The agent can take ten seconds and more to start answering in a long thread,
// so the silence is filled in two steps: an instant recorded "mm-hm" the
// moment the pause is detected, then one sentence from a small resident model
// (the quick voice) a second or two later. The agent's answer follows.
//
// The reply is followed through the thread's event log rather than the chat
// view: bb stores the agent's text as it is written, so the first sentence can
// be spoken before the agent has finished the rest.
import { startBargeInMonitor, type BargeInMonitor } from "@/lib/barge-in";
import { encodeWav, startDictation, toBase64, type DictationSession } from "@/lib/dictation";
import { couldNotSpeakText, describeError, describeFailure } from "@/lib/failures";
import { SentenceStream } from "@/lib/sentences";
import type {
  ConversationConfig,
  ConversationTiming,
  QuickReplyResult,
  SpeakResult,
  SpokenClip,
  TranscriptionResult,
} from "@/contract";

export type ConversationStatus = "off" | "listening" | "thinking" | "speaking";

/** The part of a thread event row the conversation reads. */
export interface ReplyEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface RecentLine {
  who: "user" | "agent";
  text: string;
}

export interface ConversationDeps {
  threadId: string;
  config(): Promise<ConversationConfig>;
  fillers(): Promise<{ ack: SpokenClip[]; wait: SpokenClip[] }>;
  transcribe(input: { audioBase64: string; mimeType: string }): Promise<TranscriptionResult>;
  /** Put the phrase in the composer and send it. */
  submit(text: string): Promise<void>;
  quickReply(text: string, recent: RecentLine[]): Promise<QuickReplyResult>;
  speak(text: string): Promise<SpeakResult>;
  /** The thread's newest event sequence number, or 0 for an empty thread. */
  latestSeq(): Promise<number>;
  /** Events after `afterSeq`, oldest first, at most a page. */
  eventsAfter(afterSeq: number): Promise<ReplyEvent[]>;
  log(entry: ConversationTiming): void;
  onStatus(status: ConversationStatus): void;
  onLevel(level: number): void;
  /** A failure, already worded in the interface language. */
  onError(message: string): void;
}

/** How often the event log is read while a reply streams in. */
const POLL_MS = 120;
/** A reply that has not finished by then is left to the chat; listening resumes. */
const REPLY_LIMIT_MS = 10 * 60_000;
/** Silence this long while the agent works earns one "still on it". */
const WAIT_FILLER_MS = 7_000;
/** Lines of the conversation the quick voice sees: enough to know the topic. */
const RECENT_LINES = 6;
const REPLY_EVENT_TYPES = new Set(["item/agentMessage/delta", "turn/completed"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deltaOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as { delta?: unknown; parentToolCallId?: unknown };
  // Text from a subagent belongs to its tool call, not to the reply.
  if (record.parentToolCallId !== undefined && record.parentToolCallId !== null) return null;
  return typeof record.delta === "string" ? record.delta : null;
}

/** A few silent samples: playing them inside the click unlocks audio on iOS. */
function silentClip(): string {
  return `data:audio/wav;base64,${toBase64(encodeWav(new Float32Array(800), 16_000))}`;
}

function pick<T>(items: readonly T[]): T | null {
  return items.length === 0 ? null : (items[Math.floor(Math.random() * items.length)] as T);
}

export class Conversation {
  private status: ConversationStatus = "off";
  /** Bumped on stop: every async step checks it and bows out when it moved on. */
  private generation = 0;
  private session: DictationSession | null = null;
  private monitor: BargeInMonitor | null = null;
  private audio: HTMLAudioElement | null = null;
  /** Clips play one after another on the one audio element. */
  private audioChain: Promise<void> = Promise.resolve();
  private lastAudioEnd = 0;
  private wakeListen: (() => void) | null = null;
  private interruptReply: (() => void) | null = null;
  private ack: SpokenClip[] = [];
  private wait: SpokenClip[] = [];
  private recent: RecentLine[] = [];

  constructor(private readonly deps: ConversationDeps) {}

  get current(): ConversationStatus {
    return this.status;
  }

  /** Call from the click that turns the mode on: audio may only start in a user gesture. */
  start(): void {
    if (this.status !== "off") return;
    this.generation += 1;
    const generation = this.generation;
    this.audio = new Audio();
    this.audio.src = silentClip();
    void this.audio.play().catch(() => {});
    this.setStatus("listening");
    void this.run(generation).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.deps.onError(describeError(error));
      this.stop();
    });
  }

  stop(): void {
    this.generation += 1;
    this.wakeListen?.();
    this.interruptReply?.();
    void this.session?.cancel();
    this.session = null;
    this.monitor?.stop();
    this.monitor = null;
    this.audio?.pause();
    this.audio = null;
    this.deps.onLevel(0);
    this.setStatus("off");
  }

  /** Stop reading the current reply and listen. */
  skip(): void {
    this.interruptReply?.();
  }

  private alive(generation: number): boolean {
    return generation === this.generation;
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatus(status);
  }

  private async run(generation: number): Promise<void> {
    const config = await this.deps.config();
    // Synthesized once on the server; the first phrase may go without them.
    void this.deps
      .fillers()
      .then((fillers) => {
        this.ack = fillers.ack;
        this.wait = fillers.wait;
      })
      .catch(() => {});
    while (this.alive(generation)) {
      const phrase = await this.listen(generation, config);
      if (phrase === null) continue;
      await this.exchange(generation, config, phrase);
    }
  }

  /** One phrase, recognized; null when nothing was said or the mode was turned off. */
  private async listen(
    generation: number,
    config: ConversationConfig,
  ): Promise<{ text: string; endedAt: number; ackAt: number | null; transcribedAt: number } | null> {
    this.setStatus("listening");
    const texts = new Map<number, Promise<string>>();
    const ended = new Promise<void>((resolve) => {
      this.wakeListen = resolve;
    });
    const session = await startDictation({
      onLevel: (level) => this.deps.onLevel(level),
      onError: (message) => this.deps.onError(message),
      endOfSpeechMs: config.endOfSpeechMs,
      onSpeechEnd: () => this.wakeListen?.(),
      onSegment: ({ index, wav }) => {
        texts.set(
          index,
          this.deps
            .transcribe({ audioBase64: toBase64(wav), mimeType: "audio/wav" })
            .then((result) => {
              if (result.ok) return result.text;
              this.deps.onError(describeFailure(result.code, result.message));
              return "";
            })
            .catch((error: unknown) => {
              this.deps.onError(describeError(error));
              return "";
            }),
        );
      },
    });
    if (!this.alive(generation)) {
      await session.cancel();
      return null;
    }
    this.session = session;
    await ended;
    this.wakeListen = null;
    if (!this.alive(generation)) return null;

    // The user went quiet `endOfSpeechMs` ago: that is when the wait began for them.
    const endedAt = performance.now() - config.endOfSpeechMs;
    this.session = null;
    this.deps.onLevel(0);
    this.setStatus("thinking");
    // Closing the microphone first keeps the acknowledgement out of the recording.
    const stopping = session.stop();
    const ack = pick(this.ack);
    const ackAt = ack === null ? null : performance.now();
    if (ack !== null) void this.play(ack, () => {});
    await stopping;
    const parts = await Promise.all(
      [...texts.entries()].sort(([left], [right]) => left - right).map(([, text]) => text),
    );
    if (!this.alive(generation)) return null;
    const text = parts
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" ");
    if (text === "") return null;
    return { text, endedAt, ackAt, transcribedAt: performance.now() };
  }

  /** Send the phrase, then speak the quick voice and the reply as it streams in. */
  private async exchange(
    generation: number,
    config: ConversationConfig,
    phrase: { text: string; endedAt: number; ackAt: number | null; transcribedAt: number },
  ): Promise<void> {
    const since = (at: number | null) => (at === null ? null : Math.round(at - phrase.endedAt));
    const recent = this.recent.slice(-RECENT_LINES);
    // Started before sending: it needs only the words, and every second counts.
    const quick = config.quickVoice
      ? this.deps.quickReply(phrase.text, recent).catch(() => null)
      : null;
    const afterSeq = await this.deps.latestSeq();
    await this.deps.submit(config.marker === "" ? phrase.text : `${phrase.text} ${config.marker}`);
    const submittedAt = performance.now();
    // "Still on it" counts the silence from the end of the phrase at the latest.
    this.lastAudioEnd = Math.max(this.lastAudioEnd, phrase.endedAt);

    const stream = new SentenceStream();
    const playlist: Promise<SpeakResult>[] = [];
    const spoken: string[] = [];
    let wakePlayer: (() => void) | null = null;
    const enqueue = (sentences: readonly string[]) => {
      for (const sentence of sentences) {
        spoken.push(sentence);
        playlist.push(this.deps.speak(sentence));
      }
      if (sentences.length > 0) wakePlayer?.();
    };

    let turnDone = false;
    let interrupted = false;
    let replyChars = 0;
    let firstTextAt: number | null = null;
    let firstSentenceAt: number | null = null;
    let turnDoneAt: number | null = null;
    let firstAudioAt: number | null = null;
    let playingAt: number | null = null;
    let firstSynthMs: number | null = null;
    let quickTextAt: number | null = null;
    let quickPlayingAt: number | null = null;
    const stillOn = () => this.alive(generation) && !interrupted;

    this.interruptReply = () => {
      interrupted = true;
      this.audio?.pause();
      wakePlayer?.();
    };

    const listenForBargeIn = () => {
      if (!config.bargeIn || this.monitor !== null) return;
      void startBargeInMonitor(() => this.interruptReply?.())
        .then((monitor) => {
          if (stillOn() && this.monitor === null) this.monitor = monitor;
          else monitor.stop();
        })
        .catch(() => {});
    };

    const follow = async () => {
      let seq = afterSeq;
      const deadline = submittedAt + REPLY_LIMIT_MS;
      while (stillOn() && !turnDone && performance.now() < deadline) {
        const rows = await this.deps.eventsAfter(seq);
        for (const row of rows) {
          seq = Math.max(seq, row.seq);
          if (!REPLY_EVENT_TYPES.has(row.type)) continue;
          if (row.type === "turn/completed") {
            turnDone = true;
            turnDoneAt = performance.now();
            enqueue(stream.flush());
            break;
          }
          const delta = deltaOf(row.data);
          if (delta === null) continue;
          firstTextAt ??= performance.now();
          replyChars += delta.length;
          const sentences = stream.push(delta);
          if (sentences.length > 0) firstSentenceAt ??= performance.now();
          enqueue(sentences);
        }
        if (rows.length === 0) await sleep(POLL_MS);
      }
      turnDone = true;
      wakePlayer?.();
    };

    /** Resolves when the reply has a sentence queued, or the turn is over. */
    const replyQueued = () =>
      new Promise<void>((resolve) => {
        if (playlist.length > 0 || turnDone) {
          resolve();
          return;
        }
        wakePlayer = resolve;
      });

    const playQuick = async () => {
      if (quick === null) return;
      // The quick voice only speaks if it beats the agent's own first sentence.
      const first = await Promise.race([
        quick.then((result) => ({ kind: "quick" as const, result })),
        replyQueued().then(() => ({ kind: "reply" as const, result: null })),
      ]);
      wakePlayer = null;
      if (first.kind !== "quick" || first.result === null || !first.result.ok) return;
      if (!stillOn() || playlist.length > 0) return;
      quickTextAt = performance.now();
      await this.play(first.result.clip, () => {
        quickPlayingAt ??= performance.now();
        this.setStatus("speaking");
        listenForBargeIn();
      });
    };

    const play = async () => {
      await playQuick();
      let index = 0;
      let reported = false;
      let waitUsed = false;
      while (stillOn()) {
        if (index >= playlist.length) {
          if (turnDone) break;
          await Promise.race([replyQueued(), sleep(500)]);
          wakePlayer = null;
          const quiet = performance.now() - this.lastAudioEnd;
          if (index >= playlist.length && !turnDone && !waitUsed && quiet >= WAIT_FILLER_MS) {
            const filler = pick(this.wait);
            waitUsed = true;
            if (filler !== null) await this.play(filler, () => {});
          }
          continue;
        }
        const result = await (playlist[index] as Promise<SpeakResult>);
        index += 1;
        if (!stillOn()) break;
        if (!result.ok) {
          // A fragment with nothing pronounceable is skipped quietly; a broken
          // service is worth one message per reply, not one per sentence.
          if (result.code !== "empty" && !reported) {
            reported = true;
            this.deps.onError(couldNotSpeakText(result.code, result.message));
          }
          continue;
        }
        if (firstAudioAt === null) {
          firstAudioAt = performance.now();
          firstSynthMs = result.synthMs;
        }
        await this.play(result, () => {
          playingAt ??= performance.now();
          this.setStatus("speaking");
          listenForBargeIn();
        });
      }
    };

    await Promise.all([follow(), play()]);
    this.monitor?.stop();
    this.monitor = null;
    this.interruptReply = null;
    if (!this.alive(generation)) return;

    this.recent.push({ who: "user", text: phrase.text });
    if (spoken.length > 0) this.recent.push({ who: "agent", text: spoken.join(" ").slice(0, 400) });
    this.recent = this.recent.slice(-RECENT_LINES * 2);

    this.deps.log({
      at: Date.now(),
      threadId: this.deps.threadId,
      words: phrase.text.split(/\s+/).filter(Boolean).length,
      replyChars,
      transcribedMs: since(phrase.transcribedAt),
      submittedMs: since(submittedAt),
      ackMs: since(phrase.ackAt),
      quickTextMs: since(quickTextAt),
      quickPlayingMs: since(quickPlayingAt),
      firstTextMs: since(firstTextAt),
      firstSentenceMs: since(firstSentenceAt),
      firstAudioMs: since(firstAudioAt),
      playingMs: since(playingAt),
      turnDoneMs: since(turnDoneAt),
      firstSynthMs,
      sentences: playlist.length,
      interrupted,
    });
  }

  /** Queue a clip on the audio element; resolves when it ended or was cut off. */
  private play(clip: { audioBase64: string; mimeType: string }, onPlaying: () => void): Promise<void> {
    const next = this.audioChain.then(() => this.playNow(clip, onPlaying));
    this.audioChain = next.catch(() => {});
    return next;
  }

  private playNow(clip: { audioBase64: string; mimeType: string }, onPlaying: () => void): Promise<void> {
    const audio = this.audio;
    if (audio === null) return Promise.resolve();
    const bytes = Uint8Array.from(atob(clip.audioBase64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: clip.mimeType }));
    return new Promise<void>((resolve) => {
      const done = () => {
        audio.onended = null;
        audio.onerror = null;
        audio.onpause = null;
        URL.revokeObjectURL(url);
        this.lastAudioEnd = performance.now();
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.onpause = done;
      audio.src = url;
      audio
        .play()
        .then(onPlaying)
        .catch(done);
    });
  }
}
