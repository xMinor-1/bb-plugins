# Voice Ink

Dictate into bb's composer with a Whisper model running on your own machine.
No account, no API key, no audio leaving the box.

bb routes voice transcription to whichever plugin registers an AI service of
kind `voice`. Out of the box that is the Codex plugin, so the microphone button
disappears when Codex is disabled. This plugin registers its own service and
answers it from [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
running next to bb.

## What you get

- **bb's own microphone button**, working again — every client has it,
  including the phone app. Point `BB_TRANSCRIPTION` at this plugin (below).
- **`bb voice-ink transcribe <file>`** for anything already recorded.
- **An optional second button in the composer** (setting: *Show this plugin's
  own microphone button*, off by default). It cuts speech at pauses and
  recognizes it while you keep talking, and has no per-request time limit —
  useful with a slower model on a machine that can spare the CPU. It renders
  only where plugin frontends run, so not in the phone app.

## Requirements

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

To also take over bb's built-in microphone button:

```sh
npx bb-app config set BB_TRANSCRIPTION voice-ink/local
```

The part after the slash is a label; the model comes from the plugin's
settings.

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
| `small` (default) | 3 s for a short phrase, ~6 s for fifteen seconds | usable, mangles rarer terms |
| `medium` | 7–15 s depending on how busy the machine is | noticeably better |
| `large-v3-turbo` | ~11 s | no better than `medium` at int8 on this CPU |

bb's own microphone button gives a plugin **10 seconds per attempt**, which
only `small` clears with room to spare on this hardware. `medium` is worth it
only through the plugin's own button, which has no such limit.

A machine with an NVIDIA GPU is a different story: set **Precision** to
`float16` and the same models run several times faster.

## Settings

| setting | what it does |
|---|---|
| Model | `small`, `medium` or `large-v3-turbo` |
| Spoken language | `auto`, `ru`, `en` — naming the language avoids misdetection on short phrases |
| Vocabulary hints | names and terms fed to the model as context, one line |
| Precision | `int8` (CPU), `int8_float32`, `float32` |
| CPU threads / Batch size | leave alone unless the machine is bigger or busier; batching is off because it hands the model VAD-split chunks whose opening words the smaller models drop |
| Show this plugin's own microphone button | a second, streaming button in the composer next to bb's own |
| Python interpreter | absolute path when `faster-whisper` lives in a virtualenv |
| Unload the model after N idle minutes | `0` keeps it loaded; unloading means the next phrase pays for the load again, which bb's own button has no time for |

Changing a setting retires the resident worker; the next phrase runs on the new
configuration.

## How it works

```
app.tsx          microphone button in the composer
lib/dictation.ts capture at 16 kHz, cut at pauses, encode WAV
server.ts        AI-service registration, settings, CLI, RPC
src/host.ts      the bb.host entry, running on the machine bb runs on
python/worker.py resident faster-whisper process, model kept in memory
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
