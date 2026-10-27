#!/usr/bin/env python3
"""Tests for the text normalization of tts_server.py.

Run with the service venv (num2words lives there):

    ~/.local/share/voice-ink-tts/venv/bin/python -I -B test_tts_normalize.py

With VOICE_INK_TTS_LIVE=1 the live fuzz test also posts random text to the running
service and checks that it never answers 500.
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tts_server import display_text, normalize, split_chunks  # noqa: E402

ALLOWED_RE = re.compile(r"^[а-яёА-ЯЁ .,!?:;\-—+]*$")


def spoken(text: str) -> str:
    return display_text(normalize(text))


class MarkdownTest(unittest.TestCase):
    def test_code_block_is_dropped(self):
        text = "Запусти:\n```bash\nnpm run build\nls -la\n```\nи всё."
        self.assertEqual(spoken(text), "Запусти: и всё.")

    def test_unclosed_code_block_is_dropped(self):
        self.assertEqual(spoken("Вот код.\n```python\nprint(1)\n"), "Вот код.")

    def test_code_only_is_empty(self):
        self.assertEqual(normalize("```\nx = 1\n```"), "")

    def test_table_is_dropped(self):
        text = "До таблицы.\n\n| Колонка | Значение |\n|---|:---:|\n| a | 1 |\n| b | 2 |\n\nПосле таблицы."
        self.assertEqual(spoken(text), "До таблицы. После таблицы.")

    def test_heading_and_list_become_sentences(self):
        text = "## Итоги\n\n- первый пункт\n- второй **важный** пункт\n1. третий"
        self.assertEqual(spoken(text), "Итоги. первый пункт. второй важный пункт. третий.")

    def test_task_list(self):
        self.assertEqual(spoken("- [x] сделано\n- [ ] осталось"), "сделано. осталось.")

    def test_emphasis_markers(self):
        self.assertEqual(spoken("Это **очень** __важно__ и *тоже* _так_."), "Это очень важно и тоже так.")

    def test_link_keeps_text(self):
        self.assertEqual(spoken("Смотри [документацию](https://example.com/a/b)."), "Смотри документацию.")

    def test_bare_url(self):
        self.assertEqual(spoken("Адрес https://example.com/x?a=1, проверь."), "Адрес ссылка, проверь.")
        self.assertEqual(spoken("Открой www.site.ru."), "Открой ссылка.")

    def test_inline_code_content_is_read(self):
        self.assertEqual(spoken("Переменная `token` готова."), "Переменная токен готова.")

    def test_inline_code_with_path_is_skipped(self):
        self.assertEqual(spoken("Открой `~/Work/a.txt` сейчас."), "Открой сейчас.")
        self.assertEqual(spoken("Команда `cd /tmp && ls` готова."), "Команда готова.")

    def test_blockquote_and_rule(self):
        self.assertEqual(spoken("> цитата\n\n---\n\nтекст"), "цитата. текст.")

    def test_soft_line_break_does_not_split_sentence(self):
        self.assertEqual(spoken("первая часть\nвторая часть."), "первая часть вторая часть.")

    def test_html_tags_and_entities(self):
        self.assertEqual(spoken("один<br>два &amp; три"), "один два и три.")


class NumbersTest(unittest.TestCase):
    def test_integers(self):
        self.assertEqual(spoken("Тестов 42."), "Тестов сорок два.")
        self.assertEqual(spoken("Порт 38951."), "Порт тридцать восемь тысяч девятьсот пятьдесят один.")

    def test_decimal_and_version(self):
        self.assertEqual(spoken("Точность 0.47."), "Точность ноль точка сорок семь.")
        self.assertEqual(spoken("Версия 1.8.0 вышла."), "Версия один точка восемь точка ноль вышла.")
        self.assertEqual(spoken("Ставлю v0.10."), "Ставлю версия ноль точка десять.")
        self.assertEqual(spoken("Шаг 0.05."), "Шаг ноль точка ноль пять.")

    def test_comma_decimal(self):
        self.assertEqual(spoken("Примерно 3,5 раза."), "Примерно три запятая пять раза.")

    def test_list_of_numbers_is_not_a_decimal(self):
        self.assertEqual(spoken("Номера 1,2,3."), "Номера один, два, три.")

    def test_time(self):
        self.assertEqual(spoken("В 19:57 готово."), "В девятнадцать пятьдесят семь готово.")
        self.assertEqual(spoken("В 9:05 готово."), "В девять ноль пять готово.")

    def test_dates(self):
        expected = "Срок двадцать седьмое октября две тысячи двадцать шестого года."
        self.assertEqual(spoken("Срок 27.10.2026."), expected)
        self.assertEqual(spoken("Срок 2026-10-27."), expected)

    def test_percent_and_number_sign(self):
        self.assertEqual(spoken("Готово 95%."), "Готово девяносто пять процентов.")
        self.assertEqual(spoken("Задача #37 и № 5."), "Задача номер тридцать семь и номер пять.")

    def test_range(self):
        self.assertEqual(spoken("Займёт 3–5 дней."), "Займёт от трёх до пяти дней.")

    def test_ordinals(self):
        self.assertEqual(spoken("2-й раз, в 90-х, 5-ти минут."), "второй раз, в девяностых, пяти минут.")

    def test_thousands_with_spaces(self):
        self.assertEqual(spoken("Цена 10 000 ₽."), "Цена десять тысяч рублей.")

    def test_units_and_currency(self):
        self.assertEqual(spoken("Модель 5 ГБ, ответ 100 мс, $20."),
                         "Модель пять гигабайт, ответ сто миллисекунд, двадцать долларов.")

    def test_negative(self):
        self.assertEqual(spoken("Было -5 градусов."), "Было минус пять градусов.")

    def test_letters_glued_to_digits(self):
        self.assertEqual(spoken("X5 и H264."), "икс пять и эйч двести шестьдесят четыре.")


class LatinTest(unittest.TestCase):
    def test_terms_dictionary(self):
        cases = {
            "GitHub": "гитхаб", "bb": "би би", "Claude": "клод", "Claude Code": "клод код",
            "API": "эй пи ай", "PR": "пи ар", "URL": "ю ар эл", "OK": "окей", "Mac": "мак",
            "iPhone": "айфон", "Telegram": "телеграм", "Docker": "докер", "Python": "пайтон",
            "npm": "эн пи эм", "ElevenLabs": "илевен лабс", "Vosk": "воск", "Whisper": "виспер",
            "Piper": "пайпер", "Silero": "силеро", "VPN": "ви пи эн", "CPU": "си пи ю",
            "GPU": "джи пи ю",
        }
        for latin, russian in cases.items():
            with self.subTest(latin=latin):
                self.assertEqual(spoken(f"Это {latin} тут."), f"Это {russian} тут.")

    def test_terms_are_case_insensitive(self):
        self.assertEqual(spoken("github, GITHUB, Github"), "гитхаб, гитхаб, гитхаб.")
        self.assertEqual(spoken("claude code"), "клод код.")

    def test_terms_need_word_boundaries(self):
        self.assertNotIn("би би", spoken("Слово abba тут."))

    def test_uppercase_acronym_is_spelled(self):
        self.assertEqual(spoken("Формат XYZ."), "Формат экс уай зед.")

    def test_single_letter(self):
        self.assertEqual(spoken("План B."), "План би.")

    def test_camel_and_snake_case(self):
        self.assertEqual(spoken("HTTPServer"), "эйч ти ти пи сервер.")
        self.assertEqual(spoken("snake_case"), "снэйк кэйс.")

    def test_file_name(self):
        self.assertEqual(spoken("Файл tts_server.py готов."), "Файл ти ти эс сервер точка пай готов.")

    def test_transliteration_is_cyrillic(self):
        for word in ["hello", "world", "string", "voice", "make", "the", "transliteration", "queue",
                     "rhythm", "xylophone", "knight", "psychology", "Zürich", "façade", "naïve"]:
            with self.subTest(word=word):
                out = spoken(word)
                self.assertTrue(out, word)
                self.assertRegex(out, r"^[а-яё -]+\.$")

    def test_examples(self):
        self.assertEqual(spoken("make"), "мэйк.")
        self.assertEqual(spoken("file"), "файл.")
        self.assertEqual(spoken("voice"), "войс.")
        self.assertEqual(spoken("test"), "тест.")


class SymbolsTest(unittest.TestCase):
    def test_emoji_and_foreign_scripts_vanish(self):
        self.assertEqual(normalize("😀🎉 ∑∫ 日本語 ελληνικά"), "")
        self.assertEqual(spoken("Готово 🎉!"), "Готово!")

    def test_arrows_and_comparisons(self):
        self.assertEqual(spoken("Сборка → деплой."), "Сборка — деплой.")
        self.assertEqual(spoken("Если 5 > 3."), "Если пять больше три.")

    def test_dashes(self):
        self.assertEqual(spoken("Итог – готово — и всё."), "Итог — готово — и всё.")
        self.assertEqual(spoken("что-то по-русски"), "что-то по-русски.")

    def test_ellipsis_and_punctuation_runs(self):
        self.assertEqual(spoken("Ну… ладно?! Хорошо,, давай!!!"), "Ну... ладно? Хорошо, давай!")

    def test_parentheses_become_pauses(self):
        self.assertEqual(spoken("Модель (большая) готова."), "Модель, большая, готова.")

    def test_quotes_are_dropped(self):
        self.assertEqual(spoken("Кнопка «Готово» и \"ещё\"."), "Кнопка Готово и ещё.")

    def test_abbreviations(self):
        self.assertEqual(spoken("т.е. всё и т.д. Потом РФ."), "то есть всё и так далее. Потом эр эф.")

    def test_user_plus_is_not_a_stress_mark(self):
        self.assertEqual(normalize("+а +о"), "а о.")
        self.assertEqual(spoken("2 + 2"), "два плюс два.")

    def test_empty_inputs(self):
        for text in ["", "   ", "...", "!!!", "---", "***", "|", "`x/y`", None, "🙂", "```\nls\n```"]:
            with self.subTest(text=text):
                self.assertEqual(normalize(text), "")

    def test_ukrainian_letters_are_mapped(self):
        self.assertEqual(spoken("Київ"), "Кийив.")


class StressMarksTest(unittest.TestCase):
    def test_stress_marks_only_before_vowels(self):
        out = normalize("ID, IDE, W, systemd, release, deploy")
        self.assertIn("+", out)
        self.assertIsNone(re.search(r"\+(?![аеёиоуыэюяАЕЁИОУЫЭЮЯ])", out))
        self.assertNotIn("+", display_text(out))


class ChunkTest(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(split_chunks("Привет, мир."), ["Привет, мир."])

    def test_long_text_is_split_under_limit(self):
        text = normalize("Это длинное предложение, в нём много слов и запятых. " * 30)
        chunks = split_chunks(text, limit=120)
        self.assertGreater(len(chunks), 5)
        self.assertTrue(all(len(c) <= 120 for c in chunks))
        self.assertEqual(" ".join(chunks).split(), text.split())

    def test_long_word_run_without_punctuation(self):
        text = "слово " * 200
        chunks = split_chunks(text.strip(), limit=100)
        self.assertTrue(all(0 < len(c) <= 100 for c in chunks))
        self.assertEqual(sum(c.count("слово") for c in chunks), 200)

    def test_chunks_without_letters_are_dropped(self):
        self.assertEqual(split_chunks("..."), [])


# ---- fuzz ---------------------------------------------------------------------

_CYR = ["привет", "сервер", "модель", "готово", "проверь", "ещё", "объём", "щука", "Всё", "ИИ", "РФ"]
_LAT = ["GitHub", "claude", "API", "hello", "camelCase", "snake_case", "XYZ", "bb", "x5", "Q", "naïve"]
_NUM = ["42", "0.47", "1.8.0", "19:57", "95%", "27.10.2026", "3–5", "2-й", "-5", "10 000", "#37",
        "№5", "v2", "3,5", "1,2,3", "007", "12345678901234567890", "$5", "5 ГБ", "+7"]
_MD = ["```", "```py\nx=1\n```", "|", "| a | b |\n|---|---|", "#", "## ", "**", "__", "*", "_",
       "`code`", "`a/b`", "[текст](http://x.y)", "https://example.com/a?b=c", "> ", "- ", "1. ",
       "<br>", "&amp;", "---", "~~", "[^1]"]
_SYM = ["😀", "🎉", "→", "…", "—", "–", "«", "»", "(", ")", "[", "]", "{", "}", "/", "\\", "@", "&",
        "=", "+", "<", ">", "~", "^", "%", "$", "€", "₽", "№", "°", "±", "×", "​", "﻿",
        "\t", "\n", "\r", "'", '"', ".", ",", "!", "?", ":", ";", "-", "", "+а"]


def random_text(rng: random.Random, parts: int | None = None) -> str:
    out = []
    for _ in range(parts or rng.randint(1, 25)):
        kind = rng.random()
        if kind < 0.3:
            out.append(rng.choice(_CYR))
        elif kind < 0.45:
            out.append(rng.choice(_LAT))
        elif kind < 0.6:
            out.append(rng.choice(_NUM))
        elif kind < 0.72:
            out.append(rng.choice(_MD))
        elif kind < 0.9:
            out.append(rng.choice(_SYM))
        else:
            out.append("".join(chr(rng.randint(0x20, 0x2FFF)) for _ in range(rng.randint(1, 6))))
        out.append(rng.choice([" ", " ", "", "\n", ", "]))
    return "".join(out)


class FuzzTest(unittest.TestCase):
    def test_random_input_gives_safe_text(self):
        rng = random.Random(2026)
        for _ in range(2000):
            text = random_text(rng)
            with self.subTest(text=text):
                out = normalize(text)
                self.assertRegex(out, ALLOWED_RE)
                self.assertIsNone(re.search(r"\+(?![аеёиоуыэюяАЕЁИОУЫЭЮЯ])", out))
                if out:
                    self.assertRegex(out, r"[а-яёА-ЯЁ]")
                    self.assertIn(out[-1], ".!?")
                    for chunk in split_chunks(out):
                        self.assertLessEqual(len(chunk), 280)


@unittest.skipUnless(os.environ.get("VOICE_INK_TTS_LIVE") == "1", "set VOICE_INK_TTS_LIVE=1 to fuzz the running service")
class LiveServiceFuzz(unittest.TestCase):
    """Posts random text to the running service: every answer must be 200 or 400."""

    url = os.environ.get("VOICE_INK_TTS_URL", "http://127.0.0.1:38951")
    count = int(os.environ.get("VOICE_INK_TTS_FUZZ_COUNT", "200"))

    def test_service_never_fails(self):
        rng = random.Random(int(os.environ.get("VOICE_INK_TTS_FUZZ_SEED", "37")))
        statuses: dict[int, int] = {}
        failures = []
        for i in range(self.count):
            text = random_text(rng, parts=rng.randint(1, 12))
            body = json.dumps({"text": text}).encode("utf-8")
            req = urllib.request.Request(self.url + "/synth", data=body,
                                         headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    status = resp.status
                    audio = resp.read()
                    self.assertEqual(resp.headers["Content-Type"], "audio/mpeg")
                    self.assertGreater(len(audio), 0)
            except urllib.error.HTTPError as err:
                status = err.code
                if status != 400:
                    failures.append((text, status, err.read()[:300]))
            statuses[status] = statuses.get(status, 0) + 1
        print(f"\nlive fuzz: {self.count} requests, statuses {statuses}", file=sys.stderr)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
