// Talking over the reply stops it, the way it does with a person.
//
// While a reply plays, the microphone only measures loudness: nothing is
// recorded, so the reply leaking from the speakers can never be sent back as
// the user's words. The browser's echo cancellation removes most of that leak;
// the threshold sits well above ordinary dictation's silence level so the rest
// does not count as the user starting to talk.

/** Loudness (RMS) that counts as the user talking over the reply. */
const BARGE_IN_RMS = 0.035;
/** It has to last this long: a cough or a door is shorter. */
const BARGE_IN_HOLD_MS = 350;
const POLL_MS = 50;

export interface BargeInMonitor {
  stop(): void;
}

export async function startBargeInMonitor(onBargeIn: () => void): Promise<BargeInMonitor> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let loudMs = 0;
  let fired = false;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const level = Math.sqrt(sum / samples.length);
    loudMs = level >= BARGE_IN_RMS ? loudMs + POLL_MS : 0;
    if (!fired && loudMs >= BARGE_IN_HOLD_MS) {
      fired = true;
      onBargeIn();
    }
  }, POLL_MS);

  return {
    stop() {
      clearInterval(timer);
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => {});
    },
  };
}
