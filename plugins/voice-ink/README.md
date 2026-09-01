# Voice Ink

Dictate into bb's composer with a Whisper model running on your own machine.
No account, no API key, no audio leaving the box.

bb routes voice transcription to whichever plugin registers an AI service of
kind `voice`. Out of the box that is the Codex plugin, so the microphone button
disappears when Codex is disabled. This plugin registers its own service and
answers it from [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
running next to bb.

## What you get

- **Its own microphone button in the composer.** Speech is cut at pauses and
  recognized while you keep talking, so after "stop" only the last segment is
  still running. Escape cancels a recording.
- **bb's built-in microphone button**, once `BB_TRANSCRIPTION` names this
  plugin (see below).
- **`bb voice-ink transcribe <file>`** for anything already recorded.

## Requirements

- Python 3.10+ on the machine bb runs on, with `faster-whisper` importable:
  ```sh
  pip install faster-whisper
  ```
  Point the **Python interpreter** setting at a virtualenv if you keep one.
- Roughly 1.5 GB of RAM for the `medium` model and 0.5 GB for `small`; the
  model is downloaded on first use into the plugin's data directory.

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

## Choosing a model

Whisper always runs its encoder over a 30-second window, so a three-second
phrase costs the same as a twenty-second one. What changes the wait is the
model. Measured on a 4-core Xeon 6140 with no GPU, Russian speech, model
already loaded:

| model | wait after "stop" | quality |
|---|---|---|
| `small` | ~2.5 s | usable, drops or mangles rarer words |
| `medium` | ~7 s | noticeably better, keeps punctuation |
| `large-v3-turbo` | ~11 s | no better than `medium` at int8 on this CPU |

bb's own microphone button gives a plugin **10 seconds per attempt**, which
only `small` clears with room to spare. The plugin's own button has no such
limit, so `medium` is the better default there.

A machine with an NVIDIA GPU is a different story: set **Precision** to
`float16` and the same models run several times faster.

## Settings

| setting | what it does |
|---|---|
| Model | `small`, `medium` or `large-v3-turbo` |
| Spoken language | `auto`, `ru`, `en` — naming the language avoids misdetection on short phrases |
| Vocabulary hints | names and terms fed to the model as context, one line |
| Precision | `int8` (CPU), `int8_float32`, `float32` |
| CPU threads / Batch size | leave alone unless the machine is bigger or busier |
| Python interpreter | absolute path when `faster-whisper` lives in a virtualenv |

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
the Python process stays alive between phrases and is retired after 20 idle
minutes or a settings change.

`python/worker.py` is embedded into the host bundle as a string, because the
host artifact ships as a single JavaScript file. After editing it, run:

```sh
npm run embed-worker && bb plugin build .
```
