# Voice Ink

Dictate into bb's composer with a Whisper model running on your own machine.
No account, no API key, no audio leaving the box.

bb routes voice transcription to whichever plugin registers an AI service of
kind `voice`. Out of the box that is the Codex plugin, so the microphone button
disappears when Codex is disabled. This plugin registers its own service and
answers it from one of two engines running next to bb:

- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** (default) —
  Python, with a local punctuation pass on top;
- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** — the engine
  VoiceInk uses on the Mac: a downloaded program and model, no Python at all.
  See [The whisper.cpp engine](#the-whispercpp-engine).

## What you get

- **bb's own microphone button**, working again — every client has it,
  including the phone app. Pick this plugin for voice input (below).
- **A History panel**, opened by the microphone in the sidebar footer: every
  dictation with its recording and its full text, searchable. It is where a
  long dictation ends up in one piece (below).
- **`bb voice-ink transcribe <file>`** for anything already recorded.
- **An optional second button in the composer** (setting: *Show this plugin's
  own microphone button*, off by default). It cuts speech at pauses and
  recognizes it while you keep talking, and has no per-request time limit —
  useful with a slower model on a machine that can spare the CPU. It renders
  only where plugin frontends run, so not in the phone app.

Interface: English and Russian — switch with **EN | RU** in the History panel header.

## Requirements

With **whisper.cpp**: nothing to install. The plugin downloads the program and
the model itself (about 550 MB), and needs that much free disk space.

With **faster-whisper**:

- Python 3.10+ on the machine bb runs on, with `faster-whisper` importable:
  ```sh
  pip install faster-whisper
  ```
  Point the **Python interpreter** setting at a virtualenv if you keep one.
- Roughly 1.5 GB of RAM for the `medium` model and 0.5 GB for `small`; the
  model is downloaded on first use into the plugin's data directory.
- For local punctuation, `punctuators` in the same interpreter:
  ```sh
  pip install punctuators
  ```
  Without it recognition still works, unpunctuated, and the worker logs why.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin voice-ink
bb voice-ink status          # engine state, model, resolved interpreter
bb voice-ink warmup          # load the model now instead of on the first phrase
```

To also take over bb's built-in microphone button, pick **Voice Ink (local
Whisper)** for voice input in Settings → AI services, or run either of:

```sh
bb voice-ink enable
bb settings ai-services set voice voice-ink
```

The model comes from the plugin's settings. Needs bb 0.46 or newer; older bb
read the `BB_TRANSCRIPTION` config key instead.

## The whisper.cpp engine

Set **Recognition engine** to `whisper.cpp`. The plugin then runs
`whisper-server` from whisper.cpp on `127.0.0.1` with a ggml model and talks to
it over HTTP. Defaults follow VoiceInk: `ggml-large-v3-turbo-q5_0.bin` (Large v3
Turbo, quantized), a short spoken-language sentence as the prompt so the model
punctuates, temperature 0.2. Turbo punctuates on its own; the local
punctuation pass below belongs to the faster-whisper engine.

**Two downloads, each by address and SHA-256 from the settings:** the model,
and a zip with the program for this machine (macOS on Apple silicon, Windows
x64 or Linux x64). The plugin

- checks the free disk space first and resumes a dropped download where it
  stopped (HTTP `Range`);
- refuses a file whose SHA-256 differs from the setting and keeps nothing of it;
- stores what it checked under `<host data dir>/whisper-cpp/`, named by the
  sum, so later starts need no network at all; after a switch the old version
  is deleted;
- tells bb its voice service is not ready until both files are in place, so
  bb's microphone appears once the download is done. `bb voice-ink status`
  shows the progress, and a dictation started earlier fails at once with the
  reason instead of waiting. bb's readiness poll starts a missing download by
  itself, and a failed one is tried again — after a minute when the network
  failed, after ten when the server refused or the sum was wrong — so the
  microphone comes back without restarting bb. (With faster-whisper there is
  nothing to download first: the microphone is always offered.)
- fetches a resumed download once more from the start if its sum is wrong:
  the file at the address may have changed between the two halves.

**Defaults:** the model from Hugging Face and, on Windows, the official
whisper.cpp release zip (it needs the Microsoft Visual C++ runtime installed).
There is no official build for macOS or Linux — build one as below and set its
address.

**A model in parts.** Some servers refuse a single 550 MB upload. Cut the
model (`split -b 94371840 model.bin model.bin.part-`), publish the parts, and
set **whisper.cpp model in parts**: one part per line, its address and its
SHA-256, in order. **whisper.cpp model SHA-256** stays the sum of the whole
file. Each part is checked on its own and appended to the whole, then deleted,
so the disk holds the model plus one part at most; an interrupted run goes on
with the next part. The whole is used only once its own sum matches. The
single address keeps working when the list is empty.

**Mirroring on your own server.** Put the files in a package registry or on any
HTTPS server and set the addresses and sums. If the server wants a token, set
**Header sent with the downloads**, e.g. `PRIVATE-TOKEN: <token>` for a GitLab
package registry or `Authorization: Bearer <token>`. The header goes only to
the configured origin: when the registry redirects to storage elsewhere, the
token stays behind. Downloads and their redirects go over `https` only; plain
`http` is accepted only to this machine (`localhost`, `127.0.0.0/8`, `::1`),
for a local mirror. An absolute
path (or `file:` URL), such as a network share, works the same way.

**Building the program.** The workflow
[`voice-ink-whisper-cpp.yml`](../../.github/workflows/voice-ink-whisper-cpp.yml)
builds `whisper-server` from the tag in [`whisper-cpp/VERSION`](whisper-cpp/VERSION):
macOS arm64 with Metal (the shader library embedded), Windows x64 with the CPU
variants chosen at run time and the Visual C++ runtime DLLs next to the
program, Linux x64 for AVX2. Each build is checked on `samples/jfk.wav` with
the tiny model and uploaded as a zip with its SHA-256.

**Speed** depends on the hardware far more than with faster-whisper: the Mac
build runs on the GPU through Metal, elsewhere it is CPU only. Measured on a 4-core
Xeon 6140 virtual machine with no GPU and the AVX2 build: 32 s for a
4.5-second phrase, 65 s for 27 seconds of speech, 200 s for 55 seconds — past
bb's 70-second wait for anything but a phrase. On such a machine use
faster-whisper.

Recordings are decoded in the plugin itself (WebM and Ogg with Opus, WAV; other
formats through `ffmpeg` if it is installed), cut at pauses into pieces of at
most 28 seconds and recognized one piece at a time. A server that spends more
than ten minutes on one piece is restarted (SIGTERM, then SIGKILL after five
seconds), so it cannot hold every later dictation behind it.

## Online features off

**Allow features that send text to online services** (on by default) switches
off, when cleared, everything that would reach out on its own, whatever the
other settings say:

- the transcript cleanup with a language model and the conversation mode's
  quick voice;
- a speech service for spoken replies that is not on this machine (the text of
  agent replies would go there);
- faster-whisper's own model downloads: its recognition and punctuation models
  load from the local cache only (`HF_HUB_OFFLINE=1`), so a model that was
  never downloaded reports an error instead of fetching it.

The whisper.cpp downloads still happen: they go only to the addresses in the
settings. Audio never leaves the machine in either case.

## Setup check for other plugins

Other plugins get one RPC method; the rest (history, recordings, the speech
service, transcription) answer this plugin's own panel only.

The plugin exposes a discoverable RPC, `setupStatus`, for setup pages that walk
a person through a new machine. Input `{ lang?: "en" | "ru", hostId?: string }`;
output `{ state: "done" | "todo" | "problem", summary, path }`, where `summary`
is one line for a person (the download progress while files are coming) and
`path` opens the History panel. It reads the saved state only and returns at
once.

## From speech to writing

Whisper hears words; it punctuates unevenly, rarely marks a question and never
starts a paragraph. Two passes turn its output into text you would have typed,
and the first one needs no key and no network:

**Punctuation (on by default, runs on this machine).** A small ONNX model
restores punctuation, sentence boundaries, question marks and capitalization in
about half a second on CPU. Paragraphs come from the recording itself — a pause
of at least **Start a new paragraph after a pause of N seconds** starts a new
one.

**Vocabulary hints** are fed to the recognizer as context. This is the cheapest
quality win there is: adding `супервизор` turned a stubborn *скривизору* into the
right word.

**Cleanup with a language model (optional, needs a key).** The local pass fixes
punctuation but cannot fix a misheard word. Set **Clean the transcript up with a
language model** to `groq`, `anthropic` or `openai-compatible` and paste a key,
and the transcript — never the audio — is sent for a pass that also repairs
words the recognizer got wrong. Failures fall through to the unpolished text.

## Choosing a model

Whisper always runs its encoder over a 30-second window, so a three-second
phrase costs the same as a twenty-second one. What changes the wait is the
model. Measured on a 4-core Xeon 6140 with no GPU, Russian speech, model
already loaded:

| model | wait after "stop" | quality |
|---|---|---|
| `small` (default) | 4.5 s for a phrase, 10.4 s for a minute | usable, mangles rarer terms |
| `medium` | two to three times that | noticeably better |
| `large-v3-turbo` | slower still | no better than `medium` at int8 on this CPU |

bb's own microphone button gives a plugin **70 seconds in one attempt** (bb
0.46; before that, 10 seconds per attempt and one retry), so on this hardware
`small` fits several minutes of speech and `medium` a minute or two. The
plugin's own button has no such limit.

## Long dictations

A long dictation on a slow model can take longer to recognize than bb waits, so
three things keep it from being lost:

- **A long recording is split at pauses and recognized in parallel** — but only
  when there are cores to spare (see below). One Whisper pass saturates about
  one and a half cores, so on a bigger machine three passes cut a two-minute
  dictation roughly in half.
- **Work outlives the attempt that started it.** The recognition is keyed by the
  audio, so a retry (older bb made one) joins the job already running instead
  of starting over.
- **A caller that runs out of time gets what has been recognized so far**,
  marked in the composer as partial, while recognition carries on in the
  background.
- **The whole transcript lands in History**, along with the recording — so the
  part bb never waited for is one panel away, not gone.

Measured on this machine with bb 0.43 (four cores, no GPU, two-core ceiling,
`small`): a 2:55 recording reached the composer as its first 664 characters
after bb's 19.4 seconds, and the panel held all 1993 characters 33 seconds
after the recording arrived. With bb 0.46 waiting 70 seconds, the same
recording arrives whole.

A machine with an NVIDIA GPU is a different story: set **Precision** to
`float16` and the same models run several times faster.

## History

The microphone in the sidebar footer — next to settings and the theme switch —
drops down the last six dictations, marking what is still being recognized and
what only partly reached the composer. "Open History" (or the sidebar row)
opens the full panel.

The panel lists dictations newest first: when, how long, the transcript. Open
one for the full text, a player for the recording, copy and download.

- Entries whose text outran bb's wait are labelled **only part reached the
  composer** — that label is the whole reason the panel exists.
- What is still being recognized shows as **transcribing** and fills itself in.
- From the terminal: `bb voice-ink history`, `bb voice-ink show <id>`,
  `bb voice-ink forget <id>|--all`. `bb voice-ink last` prints the most recent
  transcript.
- Only bb's own microphone button is recorded. The plugin's streaming button
  sends speech in pieces as you talk, and a list of half-sentences would be
  worse than no list.

Audio and text live in `<host data dir>/history/`, and nothing leaves the
machine. Retention is two settings — *Keep at most N dictations* (200) and
*Delete dictations older than N days* (30) — and *Keep a history of dictations*
turns the whole thing off, which also stops the recordings from being written.

## Settings

| setting | what it does |
|---|---|
| Recognition engine | `faster-whisper` (default) or `whisper.cpp` |
| Model (faster-whisper) | `small`, `medium` or `large-v3-turbo` |
| whisper.cpp model address, SHA-256 | the ggml `.bin` file and the sum of the whole file |
| whisper.cpp model in parts | one part per line: address and SHA-256; used instead of the single address when set |
| whisper.cpp program for macOS / Windows / Linux, SHA-256 | the zip for each kind of machine and its sum; empty means none for that kind |
| Header sent with the downloads | `Name: value`, secret; sent to the configured origin only |
| Allow features that send text to online services | off disables transcript cleanup, the quick voice, a speech service on another machine and faster-whisper's own downloads |
| Spoken language | `auto`, `ru`, `en` — naming the language avoids misdetection on short phrases |
| Vocabulary hints | names and terms fed to the model as context, one line |
| Precision | `int8` (CPU), `int8_float32`, `float32` |
| CPU cores recognition may use | the ceiling, default `2`; the plugin decides how to spend it (one pass with that many threads, or several parallel passes once there are at least four cores) |
| Batch size | off by default: batching hands the model VAD-split chunks whose opening words the smaller models drop |
| Show this plugin's own microphone button | a second, streaming button in the composer next to bb's own |
| Python interpreter | absolute path when `faster-whisper` lives in a virtualenv |
| Unload the model after N idle minutes | `0` keeps it loaded; unloading means the next phrase pays for the load again, which bb's own button has no time for |
| Keep a history of dictations | records audio and transcript for the History panel; off means neither is written |
| Keep at most N dictations | `0` lifts the cap |
| Delete dictations older than N days | `0` keeps them for good |

Changing a setting retires the resident worker; the next phrase runs on the new
configuration.

## Sharing the machine

bb, the agents and everything else live on the same box, so recognition is
capped and de-prioritized rather than allowed to take what it likes:

- **CPU cores recognition may use** (default `2`) is a hard ceiling: threads per
  pass times parallel passes never exceeds it, and the numeric libraries under
  ONNX and NumPy are pinned to the same number before they load. Measured while
  transcribing: 190% of one core on a four-core machine.
- The worker runs at a **lowered priority** (nice 10), so when the machine is
  busy the agents and the bb server get the cores first.

## Conversation mode

The headphones button in the composer turns a thread into a spoken
conversation: talk, pause, and the phrase is sent; the agent's reply is read
aloud while it is still being written; then the button listens again.

- **End of phrase.** A pause of `endOfSpeechMs` (900 ms by default) after at
  least 300 ms of speech sends the phrase, tagged with the conversation marker
  (`(voice)` by default) so the agent can answer briefly and without tables.
- **Reading the reply.** The reply is followed through the thread's event log
  (`item/agentMessage/delta`, `turn/completed`) and cut into sentences
  (`lib/sentences.ts`); fenced code, table rows and bb directives are skipped.
  Each sentence goes to the speech service below while the previous one plays.
- **No silence while the agent thinks.** In a long thread the agent takes ten
  seconds and more to start. The moment the pause is detected a recorded
  acknowledgement plays ("Угу.", "Секунду."), and a small resident model, the
  quick voice (`src/quick-voice.ts`, one Claude Code process in stream-json mode,
  `claude-sonnet-5-5` at low effort), says one sentence that shows the request
  was understood. It never states facts; replies that look like tool calls or
  markup are dropped. After seven quiet seconds a "still on it" filler plays once.
- **Interrupting.** Talking over the reply stops it (`lib/barge-in.ts`: the
  microphone only measures loudness while audio plays, nothing is recorded).
  Escape skips the reply; pressing the button again ends the conversation.
- **Timings.** Every exchange is logged; `bb voice-ink latency` prints them in
  seconds from the end of the phrase, and `bb voice-ink say <text> -o x.mp3`
  checks the speech service on its own.

Measured on a 4-core server: an acknowledgement synthesizes in 0.4–0.9 s and is
cached; a 3-second sentence in ~1.3 s; the quick voice's first token arrives
1.1–4.8 s after the request (a fresh `claude -p` per phrase would take ~9 s,
which is why the process stays resident).

## Spoken replies (text-to-speech service)

Voice-conversation mode reads agent replies aloud through a local Russian
text-to-speech service: `python/tts_server.py`, Vosk TTS with the
`vosk-model-tts-ru-0.10-multi` model and the `kyznetsov_vsevolod` voice. Loading
the model takes about two minutes and ~1.9 GB of memory, so it runs as a
resident systemd user service rather than inside the plugin.

### Install

The virtualenv and the model live outside any synced folder (the model is ~950 MB):

```sh
D=~/.local/share/voice-ink-tts
python3 -m venv $D/venv
$D/venv/bin/pip install --no-cache-dir vosk-tts num2words
mkdir -p $D/models && cd $D/models
curl -LO https://alphacephei.com/vosk/models/vosk-model-tts-ru-0.10-multi.zip
unzip vosk-model-tts-ru-0.10-multi.zip && rm vosk-model-tts-ru-0.10-multi.zip
ln -s <plugin dir>/python/tts_server.py $D/tts_server.py   # or copy it
cp <plugin dir>/python/voice-ink-tts.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now voice-ink-tts
```

`ffmpeg` with `libmp3lame` must be on the `PATH`. On a headless server, enable
lingering (`loginctl enable-linger`) so the service survives logout.

### API

Listens on `127.0.0.1:38951` only.

- `GET /health` → `{"ready": bool, "loadMs": int|null, "speaker": "kyznetsov_vsevolod"}`.
  The server answers right away; `ready` turns true once the model is loaded and
  warmed up.
- `POST /synth` with `{"text": str, "speaker"?: str, "rate"?: float}` → `200`
  `audio/mpeg` (mono, 22.05 kHz, 48 kbit/s). Headers: `X-Synth-Ms`, `X-Encode-Ms`,
  `X-Audio-Ms`, `X-Queue-Ms`, and `X-Spoken-Text` — the normalized text,
  URL-encoded, cut at 1000 characters (`X-Spoken-Text-Truncated: 1` then).
  `rate` is clamped to 0.5–2.0.
- `503 {"error": "loading"}` while the model loads; `400 {"error": ...}` for a bad
  body or when nothing speakable is left after normalization (skip that piece);
  `500 {"error": ...}` when synthesis fails — the service itself keeps running.

Requests are synthesized one at a time, first come first served: parallel model
runs on the same cores only slow each other down. A request whose client
disconnects while it waits in the queue is dropped without synthesis. Text over
280 characters is split at sentence and clause boundaries and the audio joined
with a short pause, so a paragraph works too, but sending one sentence per
request keeps the first sound early.

### Text normalization

The model knows only Russian letters and `. , ! ? : ; -`; anything else used to
crash it. `normalize()` turns an agent reply into something it can say:

- markdown: code blocks and table rows are dropped, headings and list items
  become sentences, emphasis markers go, `[text](url)` keeps the text, bare URLs
  become «ссылка», inline code is read unless it holds a path or a command with
  slashes;
- numbers are read in Russian: integers, decimals and versions by parts with
  «точка» (`1.8.0`), times (`19:57`), dates (`27.10.2026`), percentages, ranges
  (`3–5` → «от трёх до пяти»), `#37`/`№ 5`, ordinal endings (`2-й`, `90-х`),
  common units and currencies — without full grammatical agreement;
- Latin: a dictionary of common terms (GitHub → «гитхаб», bb → «би би», Claude
  Code → «клод код», API → «эй пи ай»…), abbreviations of 2–5 capitals spelled
  letter by letter, camelCase and snake_case split, everything else
  transliterated by rough English reading rules;
- words missing from the model dictionary get a stress mark on the first
  syllable (or on «ё»), otherwise all their vowels come out reduced.

Tests: `~/.local/share/voice-ink-tts/venv/bin/python -I -B python/test_tts_normalize.py`.
With `VOICE_INK_TTS_LIVE=1` it also posts 200 random strings (Cyrillic, Latin,
digits, emoji, markdown) to the running service and fails on any `500`.

### Measured

On a 4-core VPS with 4 onnxruntime threads, warm service:

| words | audio | synthesis | mp3 encoding | HTTP total |
|---|---|---|---|---|
| 3 | 1.4 s | 0.6 s | 77 ms | 0.7 s |
| 6 | 3.1 s | 1.1 s | 89 ms | 1.2 s |
| 10 | 4.2 s | 1.9 s | 102 ms | 2.0 s |
| 15 | 6.5 s | 2.5 s | 121 ms | 2.6 s |
| 25 | 9.6 s | 3.3 s | 145 ms | 3.5 s |

Synthesis runs at 0.35–0.45 of real time on an idle machine and up to ~0.7 when
other work takes the cores (the service runs at nice 5 and yields). Start to
`ready`: ~126 s, nearly all of it spent creating the onnxruntime session for
`model.onnx` — turning graph optimizations off does not shorten it. Memory at
rest: ~1.6 GB resident, peak ~1.95 GB while loading.

## How it works

```
app.tsx          microphone button in the composer
lib/dictation.ts capture at 16 kHz, cut at pauses, encode WAV
server.ts        AI-service registration, settings, CLI, RPC, audio route
components/      the History panel, its player, and the sidebar-footer drop-down
src/host.ts      the bb.host entry, running on the machine bb runs on
src/history.ts   recordings and transcripts on disk, and their retention
src/jobs.ts      one job per recording, shared by callers, partial text on timeout
src/whisper-cpp-engine.ts  whisper-server: downloads, start, pieces, paragraphs
src/assets.ts    resumable, sum-checked downloads (whole or in parts) and their store
src/model-parts.ts  reading the model-in-parts setting
src/audio.ts     WebM/Ogg Opus and WAV to 16 kHz mono, without ffmpeg
src/chunks.ts    cutting a recording at pauses
python/worker.py resident faster-whisper process, model kept in memory
python/tts_server.py  text-to-speech service for spoken replies (see above)
```

Loading a model costs seconds and recognizing a phrase costs less than that, so
the Python process stays alive between phrases and, by default, is never
retired for being idle — only a settings change restarts it.

The daemon may still stop the host worker (and with it the model) on its own.
The configuration is therefore mirrored to `<host data dir>/config.json`: a
worker that comes back up reads it instead of refusing the request, and loads
the model itself.

`python/worker.py` is embedded into the host bundle as a string, because the
host artifact ships as a single JavaScript file. After editing it, run:

```sh
npm run embed-worker && bb plugin build .
```

Tests: `npm test` (vitest) — decoding, cutting, downloads against a local
registry that redirects and drops connections, and the whisper.cpp engine with
a stand-in server.
