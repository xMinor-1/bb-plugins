// Microphone capture for the board and the card composer. The recording goes
// to bb's voice service — whatever the user picked in Settings, AI services —
// through useSdk().system.transcribeVoice, the same path bb's own composer uses.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";

export type RecorderState = "idle" | "recording" | "transcribing";
export type RecorderError = "mic-denied" | "not-configured" | "empty" | "failed";

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
/** Bars in the live waveform. */
const BARS = 24;
/** Hint for the recognizer: words the board hears a lot. */
const PROMPT = "Сегодня, завтра, послезавтра, в понедельник, отметь, перенеси, удали, важно, срочно.";

export function useRecorder(onText: (text: string) => void, onError: (error: RecorderError, detail?: string) => void) {
  const sdk = useSdk();
  const [state, setState] = useState<RecorderState>("idle");
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [seconds, setSeconds] = useState(0);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    audio: AudioContext | null;
    chunks: Blob[];
    raf: number;
    timer: number;
    cancelled: boolean;
  } | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const release = useCallback(() => {
    const s = session.current;
    if (!s) return;
    window.cancelAnimationFrame(s.raf);
    window.clearInterval(s.timer);
    s.stream.getTracks().forEach((t) => t.stop());
    void s.audio?.close().catch(() => undefined);
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      setState("transcribing");
      try {
        const { text } = await sdk.system.transcribeVoice({ file: blob, prompt: PROMPT });
        const clean = text.trim();
        if (clean === "") callbacks.current.onError("empty");
        else callbacks.current.onText(clean);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = (cause as { code?: string } | null)?.code;
        callbacks.current.onError(code === "not_configured" || /not.?configured|501/i.test(message) ? "not-configured" : "failed", message);
      } finally {
        setState("idle");
      }
    },
    [sdk],
  );

  const start = useCallback(async () => {
    if (session.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      callbacks.current.onError("mic-denied");
      return;
    }
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
    } catch {
      audio = null;
    }
    const started = Date.now();
    const s = {
      recorder,
      stream,
      audio,
      chunks,
      raf: 0,
      timer: window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250),
      cancelled: false,
    };
    session.current = s;
    const buffer = new Uint8Array(analyser?.frequencyBinCount ?? 0);
    let last = 0;
    const tick = (t: number) => {
      if (analyser && t - last > 70) {
        last = t;
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const v of buffer) peak = Math.max(peak, Math.abs(v - 128));
        setLevels((prev) => [...prev.slice(1), Math.min(1, peak / 64)]);
      }
      s.raf = window.requestAnimationFrame(tick);
    };
    s.raf = window.requestAnimationFrame(tick);
    recorder.onstop = () => {
      release();
      session.current = null;
      setLevels(Array(BARS).fill(0));
      if (s.cancelled) {
        setState("idle");
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (blob.size === 0) {
        setState("idle");
        callbacks.current.onError("empty");
        return;
      }
      void transcribe(blob);
    };
    setSeconds(0);
    setState("recording");
    recorder.start(250);
  }, [release, transcribe]);

  const stop = useCallback(() => {
    const s = session.current;
    if (s && s.recorder.state !== "inactive") s.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.cancelled = true;
    if (s.recorder.state !== "inactive") s.recorder.stop();
  }, []);

  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.cancelled = true;
      if (s.recorder.state !== "inactive") s.recorder.stop();
      release();
    },
    [release],
  );

  return { state, levels, seconds, start, stop, cancel };
}
