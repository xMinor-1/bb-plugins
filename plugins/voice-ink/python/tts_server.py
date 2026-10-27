#!/usr/bin/env python3
"""Local Russian text-to-speech service for the voice-ink plugin (Vosk TTS).

Speaks agent replies aloud in voice-conversation mode. The model takes about two
minutes to load and ~1.9 GB of memory, so it lives in a resident service instead
of being loaded per request.

HTTP on 127.0.0.1:38951 (standard library only):

    GET  /health  -> {"ready": bool, "loadMs": int | null, "speaker": "kyznetsov_vsevolod"}
    POST /synth   {"text": str, "speaker"?: str, "rate"?: float}
        200  audio/mpeg (mono, 48 kbit/s) with headers
             X-Synth-Ms, X-Encode-Ms, X-Audio-Ms, X-Queue-Ms,
             X-Spoken-Text (normalized text, URL-encoded)
        400  {"error": "..."}  bad request, or nothing speakable left after normalization
        503  {"error": "loading"}  model is still loading
        500  {"error": "..."}  synthesis or encoding failed

The server answers right away; the model loads in a background thread. Synthesis
runs one request at a time in FIFO order: parallel onnxruntime runs on the same few
cores only slow each other down.

Text is normalized before synthesis (see normalize()): agent replies carry markdown,
numbers and Latin words, and the model only knows Russian letters and a handful of
punctuation marks.
"""

from __future__ import annotations

import argparse
import html
import json
import logging
import os
import re
import select
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from num2words import num2words as _num2words
except ImportError:  # pragma: no cover - the venv always has it
    _num2words = None

HOST = "127.0.0.1"
DEFAULT_PORT = 38951
DEFAULT_SPEAKER = "kyznetsov_vsevolod"
DEFAULT_MODEL_DIR = os.path.expanduser(
    "~/.local/share/voice-ink-tts/models/vosk-model-tts-ru-0.10-multi"
)
DEFAULT_THREADS = 4
SAMPLE_RATE = 22050
MP3_BITRATE = "48k"

MAX_BODY_BYTES = 256 * 1024
MAX_INPUT_CHARS = 20000  # longer input is cut before normalization
MAX_SPOKEN_CHARS = 5000  # about five minutes of speech; longer is rejected
MAX_CHUNK_CHARS = 280  # one model run; keeps BERT well under its 512-token limit
CHUNK_GAP_SEC = 0.12
MAX_HEADER_TEXT_CHARS = 1000  # keeps X-Spoken-Text far below client header limits
MIN_RATE, MAX_RATE = 0.5, 2.0

log = logging.getLogger("voice-ink-tts")

# =============================================================================
# Text normalization
# =============================================================================
#
# Dictionary values may carry "+" before a vowel to mark stress. The model reads
# "+" as a stress mark for words it does not know; known words use the stress from
# its own dictionary. Inside the pipeline the mark is a private-use character, so
# that a "+" typed by the user can never turn into one.

_STRESS = "\ue000"
_RU_VOWELS = "аеёиоуыэюя"
_RU_LETTERS = "а-яё"

LATIN_TERMS = {
    # assistants and AI vendors
    "claude code": "клод код",
    "claude": "клод",
    "anthropic": "антр+опик",
    "opus": "опус",
    "sonnet": "сонет",
    "haiku": "х+айку",
    "openai": "+оупен эй ай",
    "chatgpt": "чат джи пи ти",
    "gpt": "джи пи ти",
    "codex": "кодекс",
    "gemini": "дж+емини",
    "copilot": "коп+айлот",
    "cursor": "курсор",
    "elevenlabs": "ил+евен лабс",
    "eleven labs": "ил+евен лабс",
    "vosk": "воск",
    "faster-whisper": "ф+астер виспер",
    "whisper": "виспер",
    "piper": "п+айпер",
    "silero": "сил+еро",
    "onnx": "+оникс",
    "onnxruntime": "+оникс р+антайм",
    # code hosting and tools
    "github": "гитхаб",
    "gitlab": "гитл+аб",
    "git": "гит",
    "bb": "би би",
    "getbb": "гет би би",
    "voice ink": "в+ойс инк",
    "voice-ink": "в+ойс инк",
    "docker": "докер",
    "python": "пайтон",
    "pip": "пип",
    "npm": "эн пи эм",
    "npx": "эн пи экс",
    "node.js": "нод джей эс",
    "nodejs": "нод джей эс",
    "node": "нод",
    "javascript": "джаваскр+ипт",
    "typescript": "тайпскр+ипт",
    "react": "ре+акт",
    "json": "дж+ейсон",
    "yaml": "ямл",
    "html": "эйч ти эм эл",
    "css": "си эс эс",
    "sql": "эс кью эл",
    "sqlite": "эс кью л+айт",
    "postgres": "постгр+эс",
    "postgresql": "постгр+эс",
    "redis": "р+эдис",
    "nginx": "энджин+икс",
    "caddy": "к+эдди",
    "systemd": "с+истем д+и",
    "ffmpeg": "эф эф эмп+эг",
    "syncthing": "с+инксинг",
    "cloudflare": "кл+аудфлэр",
    "vs code": "ви эс код",
    "vscode": "ви эс код",
    "c++": "си плюс плюс",
    "c#": "си шарп",
    ".net": "дот нет",
    # platforms and services
    "linux": "линукс",
    "ubuntu": "уб+унту",
    "windows": "виндоус",
    "macos": "мак о эс",
    "macbook": "макбук",
    "mac": "мак",
    "iphone": "айфон",
    "ipad": "айп+эд",
    "ios": "ай о эс",
    "android": "андроид",
    "telegram": "телеграм",
    "whatsapp": "вотс+ап",
    "youtube": "ютуб",
    "google": "гугл",
    "chrome": "хром",
    "safari": "саф+ари",
    "firefox": "ф+айрфокс",
    "yandex": "яндекс",
    "figma": "фигма",
    "notion": "н+оушн",
    "miro": "миро",
    "jira": "джира",
    "slack": "слак",
    "zoom": "зум",
    "excel": "эксель",
    "x5": "икс пять",
    # abbreviations with an established Russian reading
    "api": "эй пи ай",
    "pr": "пи ар",
    "mr": "эм ар",
    "url": "ю ар эл",
    "ok": "окей",
    "okay": "окей",
    "vpn": "ви пи эн",
    "cpu": "си пи ю",
    "gpu": "джи пи ю",
    "ssd": "эс эс д+и",
    "usb": "ю эс би",
    "ssh": "эс эс эйч",
    "http": "эйч ти ти пи",
    "https": "эйч ти ти пи эс",
    "pdf": "пэ дэ эф",
    "mp3": "эм пэ три",
    "mp4": "эм пэ четыре",
    "id": "ай д+и",
    "ui": "ю ай",
    "ux": "ю икс",
    "ai": "эй ай",
    "llm": "эл эл эм",
    "mcp": "эм си пи",
    "cli": "си эл ай",
    "sdk": "эс д+и кей",
    "tts": "ти ти эс",
    "stt": "эс ти ти",
    "ide": "ай д+и +и",
    "wi-fi": "вай фай",
    "wifi": "вай фай",
    "bluetooth": "блютус",
    # common IT words
    "e-mail": "имейл",
    "email": "имейл",
    "online": "онлайн",
    "offline": "офлайн",
    "frontend": "фронтенд",
    "backend": "бэкенд",
    "deploy": "депл+ой",
    "commit": "коммит",
    "push": "пуш",
    "pull request": "пул реквест",
    "merge": "мердж",
    "branch": "бранч",
    "issue": "+ишью",
    "issues": "+ишьюс",
    "bug": "баг",
    "release": "рел+из",
    "plugin": "плагин",
    "plugins": "плагины",
    "server": "сервер",
    "token": "токен",
    "tokens": "токены",
    "prompt": "промпт",
    "agent": "агент",
    "workflow": "в+оркфлоу",
    "taskboard": "т+аскборд",
    "todo": "ту ду",
    "readme": "ридми",
    "markdown": "м+аркдаун",
    "localhost": "л+окалхост",
    "code": "код",
}

# English letter names for spelled-out abbreviations.
LATIN_LETTER_NAMES = {
    "a": "эй", "b": "би", "c": "си", "d": "д+и", "e": "и", "f": "эф", "g": "джи",
    "h": "+эйч", "i": "ай", "j": "джей", "k": "кей", "l": "эл", "m": "эм", "n": "эн",
    "o": "+оу", "p": "пи", "q": "кь+ю", "r": "ар", "s": "эс", "t": "ти", "u": "+ю",
    "v": "ви", "w": "дабл +ю", "x": "экс", "y": "уай", "z": "з+ед",
}

# Russian letter names for consonant-only Cyrillic abbreviations (РФ, ФЗ, ПМ).
CYRILLIC_LETTER_NAMES = {
    "б": "бэ", "в": "вэ", "г": "гэ", "д": "дэ", "ж": "жэ", "з": "зэ", "й": "й+от",
    "к": "ка", "л": "эл", "м": "эм", "н": "эн", "п": "пэ", "р": "эр", "с": "эс",
    "т": "тэ", "ф": "эф", "х": "ха", "ц": "цэ", "ч": "че", "ш": "ша", "щ": "ща",
}

# Units read after a number. Case-sensitive: "м" is metres, "М" is not a unit.
UNITS = {
    "ГБ": "гигабайт", "Гб": "гигабайт", "GB": "гигабайт",
    "МБ": "мегабайт", "Мб": "мегабайт", "MB": "мегабайт",
    "КБ": "килобайт", "Кб": "килобайт", "KB": "килобайт", "kB": "килобайт",
    "ТБ": "терабайт", "TB": "терабайт",
    "кбит/с": "килобит в секунду", "kbps": "килобит в секунду",
    "Мбит/с": "мегабит в секунду", "Mbps": "мегабит в секунду",
    "мс": "миллисекунд", "ms": "миллисекунд",
    "сек": "секунд", "мин": "минут", "ч": "часов",
    "км": "километров", "кг": "килограмм", "см": "сантиметров",
    "мм": "миллиметров", "м": "метров",
    "Гц": "герц", "Hz": "герц", "кГц": "килогерц", "kHz": "килогерц",
    "МГц": "мегагерц", "MHz": "мегагерц", "ГГц": "гигагерц", "GHz": "гигагерц",
    "°C": "градусов", "°С": "градусов", "°": "градусов",
    "px": "пикселей", "k": "тысяч",
}

CURRENCY_AFTER = {"₽": "рублей", "руб.": "рублей", "руб": "рублей", "р.": "рублей",
                  "$": "долларов", "€": "евро", "£": "фунтов"}
CURRENCY_BEFORE = {"$": "долларов", "€": "евро", "£": "фунтов"}

# Cyrillic abbreviations. A trailing dot that also ends the sentence is put back.
RU_ABBREVIATIONS = [
    (r"т\.\s?е\.", "то есть"),
    (r"(?<!\d)(?<!\d\s)см\.", "смотри"),
    (r"т\.\s?д\.", "так далее"),
    (r"т\.\s?п\.", "тому подобное"),
    (r"т\.\s?к\.", "так как"),
    (r"и\s?др\.", "и другие"),
    (r"напр\.", "например"),
    (r"тыс\.", "тысяч"),
    (r"млн\.?", "миллионов"),
    (r"млрд\.?", "миллиардов"),
    (r"коп\.", "копеек"),
    (r"стр\.", "страница"),
    (r"ул\.", "улица"),
]

MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
                   "августа", "сентября", "октября", "ноября", "декабря"]

_DIGIT_WORDS = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь",
                "восемь", "девять"]

_EXTRA_CYRILLIC = {"і": "и", "ї": "йи", "є": "е", "ґ": "г", "ў": "у", "ј": "й",
                   "І": "И", "Ї": "Йи", "Є": "Е", "Ґ": "Г", "Ў": "У", "Ј": "Й"}
_LATIN_SPECIAL = {"ß": "ss", "æ": "ae", "Æ": "Ae", "ø": "o", "Ø": "O", "œ": "oe",
                  "Œ": "Oe", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L", "þ": "th"}


def _stressed(value: str) -> str:
    """Turns dictionary "+" stress marks into the internal marker."""
    return value.replace("+", _STRESS)


def _num(n: int, **kw) -> str:
    if _num2words is not None:
        try:
            return _num2words(n, lang="ru", **kw)
        except Exception:  # noqa: BLE001 - fall back to digits
            pass
    return " ".join(_DIGIT_WORDS[int(d)] for d in str(abs(n)))


def _digits_to_words(digits: str) -> str:
    """Reads a digit string: leading zeros one by one, the rest as a number."""
    if len(digits) > 15:
        return " ".join(_DIGIT_WORDS[int(d)] for d in digits)
    stripped = digits.lstrip("0")
    zeros = len(digits) - len(stripped)
    if not stripped:
        return " ".join(["ноль"] * len(digits))
    words = ["ноль"] * zeros
    words.append(_num(int(stripped)))
    return " ".join(words)


# ---- markdown ----------------------------------------------------------------

_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[^\n]*$|\Z)",
                       re.MULTILINE | re.DOTALL)
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
_HR_RE = re.compile(r"^\s*(?:[-*_=]\s*){3,}$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_QUOTE_RE = re.compile(r"^\s*(?:>\s?)+")
_LIST_RE = re.compile(r"^\s*(?:[-*+•▪◦‣]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?")
_TERMINAL_PUNCT = ".!?:;,…"


def _strip_markdown_blocks(text: str) -> str:
    text = _FENCE_RE.sub("\n", text)
    lines = text.split("\n")
    # Lines that belong to a table: a separator row, its header and its body.
    drop = set()
    for i, line in enumerate(lines):
        if _TABLE_SEP_RE.match(line):
            drop.add(i)
            if i > 0 and "|" in lines[i - 1]:
                drop.add(i - 1)
            j = i + 1
            while j < len(lines) and "|" in lines[j] and lines[j].strip():
                drop.add(j)
                j += 1
        elif line.lstrip().startswith("|"):
            drop.add(i)

    out: list[tuple[str, bool]] = []  # (text, is_structural)
    for i, line in enumerate(lines):
        if i in drop or _HR_RE.match(line):
            out.append(("", False))
            continue
        structural = False
        m = _HEADING_RE.match(line)
        if m:
            line, structural = m.group(1), True
        if _QUOTE_RE.match(line):
            line = _QUOTE_RE.sub("", line)
        if _LIST_RE.match(line):
            line, structural = _LIST_RE.sub("", line, count=1), True
        out.append((line.strip(), structural))

    # Join lines back. Headings, list items and paragraph ends become sentences,
    # otherwise they would run together into one breathless phrase.
    parts = []
    for i, (line, structural) in enumerate(out):
        if not line:
            continue
        nxt = out[i + 1] if i + 1 < len(out) else ("", True)
        ends_block = structural or not nxt[0] or nxt[1]
        if ends_block and line[-1] not in _TERMINAL_PUNCT:
            line += "."
        parts.append(line)
    return " ".join(parts)


def _inline_code(m: re.Match) -> str:
    content = m.group(2).strip()
    if len(m.group(1)) >= 3 or "/" in content or "\\" in content:
        return " "  # a code block, a path or a command line: skip it
    return " " + content + " "


def _strip_markdown_inline(text: str) -> str:
    text = re.sub(r"(`+)(.+?)\1", _inline_code, text)
    text = text.replace("`", " ")
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r" \1 ", text)
    text = re.sub(r"\[\^[^\]]*\]", " ", text)  # footnote marks
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\[[^\]]*\]", r"\1", text)
    text = re.sub(r"<(?:https?|ftp)://[^>\s]+>", " ссылка ", text)
    text = re.sub(r"</?[A-Za-z][^>\n]*>", " ", text)
    return text


# ---- links, paths ------------------------------------------------------------

_URL_RE = re.compile(r"(?:\b(?:https?|ftp)://|\bwww\.)\S+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PATH_RE = re.compile(r"(?<!\S)(?:~|\.{1,2})?/?(?:[\w.@-]+/){2,}[\w.@-]*"
                      r"|(?<!\S)(?:~|\.{1,2})/[\w.@/-]*")


def _url(m: re.Match) -> str:
    tail = re.search(r"[.,;:!?)\]»\"']+$", m.group(0))
    return " ссылка" + (tail.group(0) if tail else "") + " "


def _replace_links(text: str) -> str:
    text = _URL_RE.sub(_url, text)
    text = _EMAIL_RE.sub(" почтовый адрес ", text)
    text = _PATH_RE.sub(" ", text)
    return text


# ---- Latin terms -------------------------------------------------------------

def _build_terms_re() -> re.Pattern:
    keys = sorted(LATIN_TERMS, key=len, reverse=True)
    alt = "|".join(r"\s+".join(re.escape(part) for part in k.split(" ")) for k in keys)
    # Not inside a dotted name: "server" in "tts_server.py" is left to _replace_latin.
    return re.compile(r"(?<![A-Za-z0-9])(?<![A-Za-z0-9]\.)(?:" + alt + r")(?![A-Za-z0-9+#]|\.[A-Za-z])",
                      re.IGNORECASE)


_TERMS_RE = _build_terms_re()


def _term(m: re.Match) -> str:
    key = re.sub(r"\s+", " ", m.group(0).lower())
    return " " + _stressed(LATIN_TERMS[key]) + " "


# ---- symbols -----------------------------------------------------------------

def _replace_symbols(text: str) -> str:
    text = text.replace("…", "...")
    text = re.sub(r"[→⇒⟶➔➜]|->|=>|[←⇐⟵]|<-|[↔⇔]", " — ", text)
    text = re.sub(r">=|≥", " больше или равно ", text)
    text = re.sub(r"<=|≤", " меньше или равно ", text)
    text = re.sub(r"!=|≠", " не равно ", text)
    text = re.sub(r"(?<=[\s\d])>(?=[\s\d])", " больше ", text)
    text = re.sub(r"(?<=[\s\d])<(?=[\s\d])", " меньше ", text)
    text = re.sub(r"={1,3}", " равно ", text)
    text = text.replace("±", " плюс минус ")
    text = re.sub(r"[≈~](?=\s?\d)", " примерно ", text)
    text = re.sub(r"(?<=\d)\s?[×x]\s?(?=\d)", " на ", text)
    text = text.replace("&", " и ")
    text = re.sub(r"(?<=[\d\s])\+(?=\s?\d)", " плюс ", text)
    text = text.replace("+", " ")
    text = re.sub(r"[−‒–―]", "—", text)  # minus sign and dashes -> one dash
    text = re.sub(r"[(\[{]", ", ", text)
    text = re.sub(r"[)\]}]", ", ", text)
    text = re.sub(r"[\"'«»„“”‘’‚‹›`´]", " ", text)
    return text


# ---- Cyrillic abbreviations --------------------------------------------------

_RU_ABBREVIATIONS_RE = [
    (re.compile(r"(?<![" + _RU_LETTERS + r"])" + pattern + r"(?![" + _RU_LETTERS + r"])"
                r"(?=(\s*$|\s+(?-i:[А-ЯЁA-Z]))?)", re.IGNORECASE), spoken)
    for pattern, spoken in RU_ABBREVIATIONS
]


def _ru_abbreviations(text: str) -> str:
    for rx, spoken in _RU_ABBREVIATIONS_RE:
        # Keep the dot when the abbreviation also ends the sentence.
        text = rx.sub(lambda m, s=spoken: s + (
            "." if m.group(0).endswith(".") and m.group(1) is not None else ""), text)
    # "в 2026 г." -> "года"
    text = re.sub(r"(?<=\d)\s?гг\.", " годов", text)
    text = re.sub(r"(?<=\d)\s?г\.", " года", text)
    return text


def _spell_cyrillic(m: re.Match) -> str:
    return " " + " ".join(_stressed(CYRILLIC_LETTER_NAMES[c]) for c in m.group(0).lower()) + " "


_CYR_ACRONYM_RE = re.compile(r"(?<![А-ЯЁа-яё])[БВГДЖЗЙКЛМНПРСТФХЦЧШЩ]{2,5}(?![А-ЯЁа-яё])")


# ---- numbers -----------------------------------------------------------------

_ORDINAL_SUFFIXES = {
    "й": {}, "ый": {}, "ий": {}, "ой": {},
    "я": {"gender": "f"}, "ая": {"gender": "f"},
    "е": {"gender": "n"}, "ое": {"gender": "n"},
    "ые": {"plural": True},
    "ю": {"gender": "f", "case": "accusative"}, "ую": {"gender": "f", "case": "accusative"},
    "го": {"case": "genitive"}, "ого": {"case": "genitive"},
    "му": {"case": "dative"}, "ому": {"case": "dative"},
    "м": {"case": "prepositional"}, "ом": {"case": "prepositional"},
    "ым": {"case": "instrumental"},
    "ыми": {"case": "instrumental", "plural": True},
    "ых": {"case": "genitive", "plural": True},
}
_ORDINAL_RE = re.compile(
    r"(?<![\d.,])(\d{1,9})-(" + "|".join(
        sorted(list(_ORDINAL_SUFFIXES) + ["х", "ти", "ми"], key=len, reverse=True)
    ) + r")(?![" + _RU_LETTERS + r"])", re.IGNORECASE)


def _ordinal(m: re.Match) -> str:
    n, suffix = int(m.group(1)), m.group(2).lower()
    if suffix in ("ти", "ми") or (suffix == "х" and n < 10):
        return _num(n, case="genitive")  # 5-ти -> пяти, 2-х -> двух
    if suffix == "х":
        return _num(n, to="ordinal", case="genitive", plural=True)  # 90-х -> девяностых
    return _num(n, to="ordinal", **_ORDINAL_SUFFIXES[suffix])


def _date(day: int, month: int, year: int) -> str:
    return (f" {_num(day, to='ordinal', gender='n')} {MONTHS_GENITIVE[month - 1]}"
            f" {_num(year, to='ordinal', case='genitive')} года ")


def _time(m: re.Match) -> str:
    parts = [_num(int(m.group(1)))]
    for g in (2, 3):
        if m.group(g):
            parts.append(_digits_to_words(m.group(g)))
    return " " + " ".join(parts) + " "


def _dotted(m: re.Match) -> str:
    return " " + " точка ".join(_digits_to_words(p) for p in m.group(0).split(".")) + " "


def _units_re() -> re.Pattern:
    alt = "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True))
    return re.compile(r"(?<=\d)\s?(" + alt + r")(?![A-Za-zА-Яа-яЁё/])")


_UNITS_RE = _units_re()
_NUMBER_TOKEN = r"\d+(?:[.,:]\d+)*"


def _replace_numbers(text: str) -> str:
    # Thousands written with spaces: 10 000, 1 250 000.
    text = re.sub(r"(?<![\d.,])\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?![\d])",
                  lambda m: re.sub(r"\D", "", m.group(0)), text)
    # Attach unit words while the digits are still digits.
    text = re.sub(r"(?<=\d)\s?%", " процентов", text)
    text = text.replace("%", " ")
    text = _UNITS_RE.sub(lambda m: " " + UNITS[m.group(1)], text)
    for sign, word in CURRENCY_AFTER.items():
        text = re.sub(r"(?<=\d)\s?" + re.escape(sign) + r"(?![" + _RU_LETTERS + r"])",
                      " " + word, text)
    for sign, word in CURRENCY_BEFORE.items():
        text = re.sub(re.escape(sign) + r"\s?(" + _NUMBER_TOKEN + r")",
                      lambda m, w=word: m.group(1) + " " + w, text)
    text = re.sub(r"[$€£₽]", " ", text)

    # Dates: 27.10.2026 and 2026-10-27.
    text = re.sub(r"(?<![\d.])(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.((?:19|20)\d\d)(?![\d.]\d)",
                  lambda m: _date(int(m.group(1)), int(m.group(2)), int(m.group(3))), text)
    text = re.sub(r"(?<![\d-])((?:19|20)\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\d-])",
                  lambda m: _date(int(m.group(3)), int(m.group(2)), int(m.group(1))), text)
    # Time: 19:57, 9:05:30.
    text = re.sub(r"(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d:])", _time, text)
    # Ordinals and case endings: 2-й, 5-ти, 90-х.
    text = _ORDINAL_RE.sub(lambda m: " " + _ordinal(m) + " ", text)
    # Issue and item numbers: #37, № 5.
    text = re.sub(r"#\s?(?=\d)", " номер ", text)
    # Versions: v1.8.0 -> "версия один точка восемь точка ноль".
    text = re.sub(r"(?<![A-Za-z])[vV](?=\d)", " версия ", text)
    # Letters glued to digits: X5, 4K, H264, 5ГБ.
    text = re.sub(r"(?<=[A-Za-zА-Яа-яЁё])(?=\d)|(?<=\d)(?=[A-Za-zА-Яа-яЁё])", " ", text)
    text = re.sub(r"(?<=[A-Za-zА-Яа-яЁё])-(?=\d)|(?<=\d)-(?=[A-Za-zА-Яа-яЁё])", " ", text)
    # Ranges: 3–5 -> "от трёх до пяти".
    text = re.sub(
        r"(?<![\d.,:—-])(\d{1,9})\s?[—-]\s?(\d{1,9})(?![\d.,:]\d|\d|[—-]\d)",
        lambda m: f" от {_num(int(m.group(1)), case='genitive')}"
                  f" до {_num(int(m.group(2)), case='genitive')} ",
        text)
    # Versions, decimals, IP addresses: parts joined by "точка".
    text = re.sub(r"\d+(?:\.\d+)+", _dotted, text)
    # Comma decimals: 3,5 -> "три запятая пять".
    text = re.sub(r"(?<![\d,])(\d+),(\d+)(?![\d,]|,\d)",
                  lambda m: f" {_digits_to_words(m.group(1))} запятая {_digits_to_words(m.group(2))} ",
                  text)
    # Signs right before a number.
    text = re.sub(r"(?:^|(?<=[\s,:;]))[—-](?=\d)", " минус ", text)
    # Everything else is an integer.
    text = re.sub(r"\d+", lambda m: " " + _digits_to_words(m.group(0)) + " ", text)
    return text


# ---- Latin words -------------------------------------------------------------

_LATIN_RULES = [
    (r"^kn", "n"), (r"^wr", "r"), (r"^x", "z"),
    (r"tion", "шн"), (r"sion", "жн"), (r"ture", "чер"),
    (r"eigh", "эй"), (r"ough", "оу"), (r"augh", "о"), (r"igh", "ай"),
    (r"tch", "ч"), (r"dge", "дж"), (r"sch", "ск"),
    (r"ee", "и"), (r"ea", "и"), (r"oo", "у"), (r"ou", "ау"), (r"ow$", "оу"),
    (r"ow", "ау"), (r"oa", "оу"), (r"ai", "эй"), (r"ay", "эй"), (r"ey$", "и"),
    (r"ei", "эй"), (r"ey", "эй"), (r"oi", "ой"), (r"oy", "ой"), (r"au", "о"),
    (r"aw", "о"), (r"ew", "ью"), (r"ue$", "у"), (r"ie$", "и"),
    (r"([aiou])([bcdfgklmnprstvz])e$", None),  # magic e: make, file, code, cute
    (r"e([bcdfgklmnprstvz])e$", r"и\1"),
    (r"ar", "ар"), (r"or", "ор"), (r"er$", "ер"), (r"ur", "ер"), (r"ir", "ер"),
    (r"ph", "ф"), (r"sh", "ш"), (r"ch", "ч"), (r"th", "т"), (r"wh", "у"),
    (r"ck", "к"), (r"qu", "кв"), (r"gh", "г"), (r"ge$", "дж"),
    (r"c(?=[eiy])", "с"), (r"c", "к"), (r"j", "дж"), (r"x", "кс"), (r"q", "к"),
    (r"w(?=[aeiouy])", "в"), (r"w", "у"),
    (r"^y(?=[aeiou])", "й"),
    (r"h(?=[aeiouy])", "х"), (r"^h", "х"), (r"h", ""),
    (r"(?<=[aeiouаеёиоуыэюя])s(?=[aeiouyаеёиоуыэюя])", "з"),
]
_MAGIC_E = {"a": "эй", "i": "ай", "o": "оу", "u": "ю"}
_LATIN_CONSONANTS = {"b": "б", "d": "д", "f": "ф", "g": "г", "k": "к", "l": "л", "m": "м",
                     "n": "н", "p": "п", "r": "р", "s": "с", "t": "т", "v": "в", "z": "з"}
_ANY_CONSONANT = "bcdfgklmnpqrstvwxzбвгджзйклмнпрстфхцчшщ"


def _transliterate(word: str) -> str:
    """Rough English-to-Russian reading of one Latin word. Speakable, not exact."""
    w = word.lower()
    for pattern, repl in _LATIN_RULES:
        if repl is None:
            w = re.sub(pattern, lambda m: _MAGIC_E[m.group(1)] + m.group(2), w)
        else:
            w = re.sub(pattern, repl, w)
    # A final "y" is "ай" in one-syllable words (my, by, fly) and "и" otherwise.
    if w.endswith("y"):
        has_vowel = re.search(r"[aeiouаеёиоуыэюя]", w[:-1])
        w = w[:-1] + ("и" if has_vowel else "ай")
    # A final silent "e" after another vowel (code -> handled above, "node" too).
    if len(w) > 2 and w.endswith("e") and re.search(r"[aeiouаеёиоуыэюя]", w[:-1]):
        w = w[:-1]
    out = []
    for i, ch in enumerate(w):
        nxt = w[i + 1] if i + 1 < len(w) else ""
        nxt2 = w[i + 2] if i + 2 < len(w) else ""
        closed = bool(nxt) and nxt in _ANY_CONSONANT and (not nxt2 or nxt2 in _ANY_CONSONANT)
        if ch == "a":
            out.append("э" if closed else "а")
        elif ch == "u":
            out.append("а" if closed else "ю")
        elif ch == "e":
            out.append("э" if i == 0 else "е")
        elif ch == "i" or ch == "y":
            out.append("и")
        elif ch == "o":
            out.append("о")
        elif ch in _LATIN_CONSONANTS:
            out.append(_LATIN_CONSONANTS[ch])
        else:
            out.append(ch)
    result = "".join(out)
    result = re.sub(r"([бвгдзклмнпрстфхцчшщж])\1+", r"\1", result)  # app -> эп
    return result


def _spell_latin(word: str) -> str:
    return " ".join(_stressed(LATIN_LETTER_NAMES[c]) for c in word.lower() if c in LATIN_LETTER_NAMES)


def _latin_word(m: re.Match) -> str:
    word = m.group(0).replace("'", "")
    key = word.lower()
    if key in LATIN_TERMS:
        return " " + _stressed(LATIN_TERMS[key]) + " "
    if len(word) == 1:
        return " " + _spell_latin(word) + " "
    if 2 <= len(word) <= 5 and (word.isupper() or not re.search(r"[aeiouy]", key)):
        return " " + _spell_latin(word) + " "
    return " " + _transliterate(word) + " "


def _replace_latin(text: str) -> str:
    text = re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", text)  # camelCase
    text = re.sub(r"(?<=[A-Za-z])\.(?=[A-Za-z])", " точка ", text)  # file.py
    return re.sub(r"[A-Za-z]+(?:'[A-Za-z]+)?", _latin_word, text)


# ---- final filter ------------------------------------------------------------

_DISALLOWED_RE = re.compile(r"[^" + _RU_LETTERS + r"А-ЯЁ .,!?:;\-—" + _STRESS + r"]")


def _squash_punct(m: re.Match) -> str:
    group = m.group(0)
    if "." in group and "..." in group.replace(" ", ""):
        mark = "..."
    elif "?" in group:
        mark = "?"
    elif "!" in group:
        mark = "!"
    elif "." in group:
        mark = "."
    elif ":" in group:
        mark = ":"
    elif ";" in group:
        mark = ";"
    elif "," in group:
        mark = ","
    else:
        return " — "
    return mark + " "


def _final_filter(text: str) -> str:
    text = _DISALLOWED_RE.sub(" ", text)
    # Stress marks only directly before a vowel.
    text = re.sub(_STRESS + r"+", _STRESS, text)
    text = re.sub(_STRESS + r"(?![" + _RU_VOWELS + _RU_VOWELS.upper() + r"])", "", text)
    # Hyphens: kept inside words (что-то), anything else is a dash.
    text = re.sub(r"-{2,}", "—", text)
    text = re.sub(r"(?<![" + _RU_LETTERS + r"А-ЯЁ])-|-(?![" + _RU_LETTERS + r"А-ЯЁ" + _STRESS + r"])",
                  " — ", text)
    # Punctuation runs collapse into the strongest mark.
    text = re.sub(r"[\s.,!?:;—]*[.,!?:;—][\s.,!?:;—]*", _squash_punct, text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^(?:[.,!?:;—]\s*)+", "", text)  # nothing to pause on at the start
    text = re.sub(r"\s+$", "", text)
    if not re.search(r"[" + _RU_LETTERS + r"А-ЯЁ]", text):
        return ""
    if text.endswith("—"):
        text = text[:-1].rstrip()
    if text and text[-1] not in ".!?":
        text = text.rstrip(",:;") + "."
    return text


def normalize(text) -> str:
    """Turns an agent reply into text the Vosk model can speak.

    Strips markdown, reads numbers and Latin words in Russian and drops everything
    the model has no sounds for. Returns "" when nothing speakable is left. Stress
    marks ("+" before a vowel) may appear; display_text() removes them.
    """
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    text = text[:MAX_INPUT_CHARS]
    text = html.unescape(text).replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(_STRESS, "")
    text = text.replace("№", " #")  # NFKC would turn it into "No"
    text = unicodedata.normalize("NFKC", text)
    text = "".join(_EXTRA_CYRILLIC.get(c) or _LATIN_SPECIAL.get(c) or c for c in text)
    text = _fold_latin_diacritics(text)

    text = _strip_markdown_blocks(text)
    text = _strip_markdown_inline(text)
    text = _replace_links(text)
    text = _TERMS_RE.sub(_term, text)
    text = _replace_symbols(text)
    text = _ru_abbreviations(text)
    text = _replace_numbers(text)
    text = _CYR_ACRONYM_RE.sub(_spell_cyrillic, text)
    text = _replace_latin(text)
    text = _final_filter(text)
    return text.replace(_STRESS, "+")


def _fold_latin_diacritics(text: str) -> str:
    def fold(ch: str) -> str:
        if "\u00c0" <= ch <= "\u024f":
            base = unicodedata.normalize("NFKD", ch)
            return "".join(c for c in base if c.isascii()) or ch
        return ch
    return "".join(fold(c) for c in text)


def display_text(spoken: str) -> str:
    """The normalized text without stress marks, for showing to people."""
    return spoken.replace("+", "")


def split_chunks(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Splits normalized text into pieces of at most `limit` characters.

    Cuts at sentence ends first, then at commas and dashes, then at spaces. Every
    piece holds at least one letter.
    """
    text = text.strip()
    if len(text) <= limit:
        return [text] if re.search(r"[а-яё]", text, re.IGNORECASE) else []
    sentences = re.findall(r"[^.!?]+(?:\.\.\.|[.!?])?\s*", text)
    pieces: list[str] = []
    for sentence in sentences:
        sentence = sentence.strip()
        if len(sentence) <= limit:
            pieces.append(sentence)
            continue
        for clause in re.findall(r"[^,;:—]+(?:[,;:—])?\s*", sentence):
            clause = clause.strip()
            while len(clause) > limit:
                cut = clause.rfind(" ", 0, limit)
                if cut <= 0:
                    cut = limit
                pieces.append(clause[:cut].strip())
                clause = clause[cut:].strip()
            if clause:
                pieces.append(clause)
    # Glue short neighbours back together so the model sees whole phrases.
    chunks: list[str] = []
    for piece in pieces:
        if chunks and len(chunks[-1]) + 1 + len(piece) <= limit:
            chunks[-1] = chunks[-1] + " " + piece
        else:
            chunks.append(piece)
    return [c for c in chunks if re.search(r"[а-яё]", c, re.IGNORECASE)]


# =============================================================================
# Synthesis engine
# =============================================================================


class ClientGone(Exception):
    """The client closed the connection while its request waited in the queue."""


def _client_gone(sock) -> bool:
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


class Engine:
    def __init__(self, model_dir: str, speaker: str, threads: int, ffmpeg: str, warmup: bool):
        self.model_dir = model_dir
        self.default_speaker = speaker
        self.threads = threads
        self.ffmpeg = ffmpeg
        self.warmup = warmup
        self.ready = False
        self.load_ms: int | None = None
        self.speakers: dict[str, int] = {}
        self._model = None
        self._synth = None
        self._dic: dict = {}
        # One worker thread: requests are synthesized one at a time, in order.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="synth")

    def health(self) -> dict:
        return {"ready": self.ready, "loadMs": self.load_ms, "speaker": self.default_speaker}

    def load(self) -> None:
        started = time.monotonic()
        try:
            self._load_model()
            if self.warmup:
                # The first run and the first ffmpeg start are slower; pay for them here.
                audio = self._run("Привет.", self.speakers[self.default_speaker], 1.0)
                self._encode_mp3(audio.tobytes())
        except Exception:  # noqa: BLE001
            log.error("model load failed:\n%s", traceback.format_exc())
            logging.shutdown()
            os._exit(1)  # let systemd restart us
        self.load_ms = int((time.monotonic() - started) * 1000)
        self.ready = True
        log.info("model ready in %d ms (threads=%d, warmup=%s)", self.load_ms, self.threads, self.warmup)

    def _load_model(self) -> None:
        import onnxruntime
        import vosk_tts.model as vosk_model
        from vosk_tts import Model, Synth

        threads = self.threads

        def session_options():
            opts = onnxruntime.SessionOptions()
            opts.intra_op_num_threads = threads
            opts.inter_op_num_threads = 1
            return opts

        # vosk_tts builds its sessions with default options (all cores); hand it a
        # module whose SessionOptions carries our thread count.
        shim = type("OnnxShim", (), {
            "SessionOptions": staticmethod(session_options),
            "InferenceSession": onnxruntime.InferenceSession,
            "get_available_providers": staticmethod(onnxruntime.get_available_providers),
        })
        original = vosk_model.onnxruntime
        vosk_model.onnxruntime = shim
        try:
            log.info("loading model from %s", self.model_dir)
            self._model = Model(model_path=self.model_dir)
        finally:
            vosk_model.onnxruntime = original
        self._synth = Synth(self._model)
        self._dic = self._model.dic
        self.speakers = dict(self._model.config.get("speaker_id_map", {}))
        if self.default_speaker not in self.speakers:
            raise RuntimeError(f"speaker {self.default_speaker!r} is not in the model")

    def _mark_stress(self, text: str) -> str:
        """Gives words missing from the model dictionary a stress mark.

        Unknown words otherwise come out with every vowel reduced. English-style
        transliterations mostly stress the first syllable; "ё" is always stressed.
        """
        def mark(m: re.Match) -> str:
            word = m.group(0)
            if "+" in word or word.lower() in self._dic:
                return word
            parts = []
            for part in word.split("-"):
                if not part or part.lower() in self._dic:
                    parts.append(part)
                    continue
                low = part.lower()
                pos = low.find("ё")
                if pos < 0:
                    vowel = re.search(r"[" + _RU_VOWELS + r"]", low)
                    pos = vowel.start() if vowel else -1
                parts.append(part if pos < 0 else part[:pos] + "+" + part[pos:])
            return "-".join(parts)
        return re.sub(r"[" + _RU_LETTERS + r"А-ЯЁ+\-]+", mark, text)

    def _run(self, text: str, speaker_id: int, rate: float):
        import numpy as np

        pieces = []
        gap = np.zeros(int(SAMPLE_RATE * CHUNK_GAP_SEC), dtype=np.int16)
        for chunk in split_chunks(text):
            audio = self._synth.synth_audio(self._mark_stress(chunk), speaker_id=speaker_id,
                                            speech_rate=rate)
            audio = np.asarray(audio, dtype=np.int16).reshape(-1)
            if pieces:
                pieces.append(gap)
            pieces.append(audio)
        if not pieces:
            raise RuntimeError("nothing was synthesized")
        return np.concatenate(pieces)

    def _encode_mp3(self, pcm: bytes) -> bytes:
        proc = subprocess.run(
            [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
             "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
             "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-id3v2_version", "0",
             "-f", "mp3", "pipe:1"],
            input=pcm, capture_output=True, timeout=120, check=False)
        if proc.returncode != 0 or not proc.stdout:
            raise RuntimeError("ffmpeg failed: " + proc.stderr.decode("utf-8", "replace")[-300:])
        return proc.stdout

    def submit(self, text: str, speaker_id: int, rate: float, sock):
        enqueued = time.monotonic()

        def job():
            queue_ms = int((time.monotonic() - enqueued) * 1000)
            if sock is not None and _client_gone(sock):
                raise ClientGone()
            t0 = time.monotonic()
            audio = self._run(text, speaker_id, rate)
            t1 = time.monotonic()
            mp3 = self._encode_mp3(audio.tobytes())
            t2 = time.monotonic()
            return {
                "mp3": mp3,
                "synthMs": int((t1 - t0) * 1000),
                "encodeMs": int((t2 - t1) * 1000),
                "audioMs": int(len(audio) * 1000 / SAMPLE_RATE),
                "queueMs": queue_ms,
            }

        return self._executor.submit(job)


# =============================================================================
# HTTP
# =============================================================================


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "voice-ink-tts/1"
    engine: Engine  # set in main()

    def log_message(self, fmt, *args):  # quiet default access log
        pass

    def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            self._json(200, self.engine.health())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != "/synth":
            self.close_connection = True
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._json(400 if length < 0 else 413, {"error": "bad or too large body"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if not isinstance(payload, dict):
            self._json(400, {"error": "body must be a JSON object"})
            return
        text = payload.get("text")
        if not isinstance(text, str):
            self._json(400, {"error": "text must be a string"})
            return

        engine = self.engine
        speaker = payload.get("speaker") or engine.default_speaker
        rate = payload.get("rate", 1.0)
        if rate is None:
            rate = 1.0
        if not isinstance(speaker, str):
            self._json(400, {"error": "speaker must be a string"})
            return
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate != rate:
            self._json(400, {"error": "rate must be a number"})
            return
        rate = min(max(float(rate), MIN_RATE), MAX_RATE)

        spoken = normalize(text)
        if not spoken:
            self._json(400, {"error": "nothing to speak"})
            return
        if len(spoken) > MAX_SPOKEN_CHARS:
            self._json(400, {"error": f"text too long ({len(spoken)} > {MAX_SPOKEN_CHARS} characters)"})
            return
        if not engine.ready:
            self._json(503, {"error": "loading"})
            return
        if speaker not in engine.speakers:
            self._json(400, {"error": f"unknown speaker: {speaker}"})
            return

        started = time.monotonic()
        try:
            result = engine.submit(spoken, engine.speakers[speaker], rate, self.connection).result()
        except ClientGone:
            self.close_connection = True
            log.info("synth skipped: client went away while queued")
            return
        except Exception as exc:  # noqa: BLE001
            log.error("synth failed (%d chars):\n%s", len(spoken), traceback.format_exc())
            self._json(500, {"error": f"synthesis failed: {type(exc).__name__}: {exc}"[:500]})
            return

        shown = display_text(spoken)
        headers = {
            "X-Synth-Ms": str(result["synthMs"]),
            "X-Encode-Ms": str(result["encodeMs"]),
            "X-Audio-Ms": str(result["audioMs"]),
            "X-Queue-Ms": str(result["queueMs"]),
            "X-Spoken-Text": urllib.parse.quote(shown[:MAX_HEADER_TEXT_CHARS], safe=""),
        }
        if len(shown) > MAX_HEADER_TEXT_CHARS:
            headers["X-Spoken-Text-Truncated"] = "1"
        try:
            self._send(200, result["mp3"], "audio/mpeg", headers)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return
        log.info("synth %d chars -> %d ms audio: queue %d, synth %d, encode %d, total %d ms",
                 len(spoken), result["audioMs"], result["queueMs"], result["synthMs"],
                 result["encodeMs"], int((time.monotonic() - started) * 1000))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("VOICE_INK_TTS_PORT", DEFAULT_PORT)))
    parser.add_argument("--model", default=os.environ.get("VOICE_INK_TTS_MODEL", DEFAULT_MODEL_DIR))
    parser.add_argument("--speaker", default=DEFAULT_SPEAKER)
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "/usr/bin/ffmpeg")
    parser.add_argument("--no-warmup", dest="warmup", action="store_false",
                        help="mark ready right after loading, without a first short synthesis")
    args = parser.parse_args(argv)

    # Root at WARNING: vosk_tts logs a line per model run at INFO.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(message)s")
    log.setLevel(logging.INFO)
    engine = Engine(os.path.expanduser(args.model), args.speaker, args.threads, args.ffmpeg, args.warmup)
    Handler.engine = engine
    server = Server((HOST, args.port), Handler)  # bind first: /health answers while loading
    log.info("listening on http://%s:%d", HOST, args.port)
    threading.Thread(target=engine.load, name="loader", daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
