---
name: sticker-note
description: Put things on the user's personal task board (Sticker Note) and keep stickers up to date — make a sticker, note or reminder from the conversation, list stickers, add results to one, move it, mark it done. Use when the user says "сделай стикер", "запиши в Sticker Note", "закинь на доску", "напомни", "make a sticker", or when a job came from a sticker.
---

# Sticker Note

Sticker Note is the user's own board of small tasks in bb, with columns Today,
Soon, Later and Done. Every sticker has a number (#12) that never changes.

## Make a sticker from the conversation

Call `sticker_note_add` (or `bb sticker-note add`):

- `title` — short, in the user's words and language: "Пройти ассессмент".
- `when` — the day and time if there is one: "в пятницу в 12", "2026-11-06 12:00".
- `notes` — what the user will need later: the summary, names, numbers, file paths.
- `links` — URLs.

The sticker links back to this chat, so the user can return here from it.
Then tell the user the sticker's number.

## A job that came from a sticker

A thread started from a sticker opens with "A job from the user's Sticker Note
board … sticker #N". Your final answer is copied onto the sticker, so end with a
short result and a question only when you need the user's decision; their
answer from the sticker arrives as your next message. Put lasting results on
the sticker with `sticker_note_update` (`add_notes`, `add_links`), and mark it
done only when the job completes the task itself.

## Commands

```sh
bb sticker-note add "Пройти ассессмент" --when "в пятницу в 12" --note "2 часа, слоты 12:00–14:00 и 16:00–18:00"
bb sticker-note list            # open stickers; --all adds finished ones
bb sticker-note show 12
bb sticker-note update 12 --note "Черновик ответа готов" --link https://… --done
bb sticker-note say "закрой задачи 6 и 1"
```
