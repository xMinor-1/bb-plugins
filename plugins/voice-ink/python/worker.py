#!/usr/bin/env python3
"""Resident faster-whisper worker for the voice-ink plugin.

One JSON request per line on stdin, one JSON response per line on stdout. The
model is loaded once and stays in memory: loading costs seconds, transcribing a
spoken phrase costs a fraction of that, and dictation is only usable when the
second number is the one the user waits for.

Requests:
    {"id": "1", "op": "transcribe", "path": "/tmp/a.webm",
     "language": "ru" | null, "prompt": "glossary" | null}
    {"id": "2", "op": "ping"}

Responses:
    {"id": "1", "ok": true, "text": "...", "audioSec": 3.2, "elapsedSec": 1.7}
    {"id": "1", "ok": false, "code": "request_failed", "message": "..."}

A single line is written before the first response, so the caller can tell a
warm worker from one that is still loading:
    {"event": "ready", "model": "medium", "computeType": "int8"}
    {"event": "error", "code": "auth_required", "message": "..."}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import traceback

# Batching splits the audio into windows transcribed together. It pays off on
# anything long enough to hold several windows and costs setup time on short clips,
# so short segments take the plain path.
BATCH_MIN_AUDIO_SEC = 8.0


def normalize(text: str) -> str:
    return " ".join(text.lower().split()).strip(" .,!?…-")


def join_segments(texts: list) -> str:
    """Drop Whisper's repetition loops without touching real speech.

    On a phrase that runs out mid-word the model sometimes emits the same
    fragment again and again. A repetition penalty stops that but also deletes
    genuine sentences, so the loop is removed after the fact: a fragment
    repeated back to back survives once.
    """
    kept = []
    previous = None
    repeats = 0
    for text in texts:
        current = normalize(text)
        if current == "":
            continue
        if current == previous:
            repeats += 1
            if repeats >= 1:
                continue
        else:
            repeats = 0
        previous = current
        kept.append(text.strip())
    joined = " ".join(kept)
    return re.sub(r"(\b[^.!?…]{2,40}[.!?…]\s*)\1{2,}", r"\1", joined).strip()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def failure(request_id, code: str, message: str) -> dict:
    return {"id": request_id, "ok": False, "code": code, "message": message}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="medium")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--download-root", default=None)
    args = parser.parse_args()

    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
        from faster_whisper.audio import decode_audio
    except Exception as error:  # noqa: BLE001 - reported to the host verbatim
        emit({
            "event": "error",
            "code": "auth_required",
            "message": f"faster-whisper is not installed: {error}",
        })
        return 1

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            cpu_threads=args.threads,
            download_root=args.download_root,
        )
        batched = BatchedInferencePipeline(model=model) if args.batch_size > 1 else None
    except Exception as error:  # noqa: BLE001
        emit({
            "event": "error",
            "code": "service_unavailable",
            "message": f"could not load model {args.model}: {error}",
        })
        return 1

    emit({
        "event": "ready",
        "model": args.model,
        "computeType": args.compute_type,
        "device": args.device,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit(failure(None, "request_failed", f"malformed request: {error}"))
            continue

        request_id = request.get("id")
        op = request.get("op")

        if op == "ping":
            emit({"id": request_id, "ok": True, "text": "", "audioSec": 0.0, "elapsedSec": 0.0})
            continue
        if op != "transcribe":
            emit(failure(request_id, "request_failed", f"unknown op {op!r}"))
            continue

        path = request.get("path")
        if not isinstance(path, str) or not path:
            emit(failure(request_id, "request_failed", "path is required"))
            continue

        started = time.monotonic()
        try:
            audio = decode_audio(path)
        except Exception as error:  # noqa: BLE001
            emit(failure(request_id, "request_failed", f"could not decode audio: {error}"))
            continue

        audio_sec = len(audio) / 16000.0
        if audio_sec < 0.2:
            emit({"id": request_id, "ok": True, "text": "", "audioSec": audio_sec, "elapsedSec": 0.0})
            continue

        options = {
            "beam_size": 1,
            "vad_filter": True,
            # faster-whisper waits two seconds of silence before splitting, which
            # on a dictated phrase leaves one long block whose opening words the
            # smaller models drop. Splitting at half a second keeps them.
            "vad_parameters": {"min_silence_duration_ms": 500},
            "condition_on_previous_text": False,
            "language": request.get("language") or None,
            "initial_prompt": request.get("prompt") or None,
        }
        try:
            if batched is not None and audio_sec >= BATCH_MIN_AUDIO_SEC:
                segments, _ = batched.transcribe(audio, batch_size=args.batch_size, **options)
            else:
                segments, _ = model.transcribe(audio, **options)
            text = join_segments([segment.text for segment in segments])
        except Exception as error:  # noqa: BLE001
            emit(failure(
                request_id,
                "service_unavailable",
                f"transcription failed: {error}\n{traceback.format_exc(limit=3)}",
            ))
            continue

        emit({
            "id": request_id,
            "ok": True,
            "text": text,
            "audioSec": round(audio_sec, 2),
            "elapsedSec": round(time.monotonic() - started, 2),
        })

    return 0


if __name__ == "__main__":
    sys.exit(main())
