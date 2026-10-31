# Sticker Note

A personal sticky-note board inside bb, for your own small tasks. Say a task
out loud right on the board; it lands as a card with its date, time, importance
and links filled in. Commands work by voice too, so the board rarely needs the
mouse. A job for an agent said on the board or in a card starts an agent chat
that the card follows, and any chat message can become a sticker.

The interface is in English and Russian, with a switch in the board's title bar.

## What you get

- **A board page** in bb's navigation with four columns by time: *Today*
  (ordered by the clock, with a red "now" line and overdue times in red),
  *Soon* (the next 7 days), *Later* (further out or no date) and *Done*.
  Important cards carry a folded yellow corner, low-priority ones are dimmed.
  Drag a card to another column to reschedule it; the round check marks it done.
  Hovering a card shows small buttons: move to tomorrow, mark important, delete.
- **Dictation from anywhere in bb.** Press the hotkey (Alt+S, ⌥S on a Mac, set in
  the plugin settings) and speak; press it again to add. Pressed outside the
  board, it opens the board and starts recording. The microphone button works
  too. The phrase is understood at once and its parts are highlighted: when,
  importance, work, links.
  - New tasks: "Tomorrow at 10 call the service about the MOT", "On Thursday renew
    the car insurance sravni.ru", "Someday buy vacuum filters", "Вечером в полвосьмого
    забрать посылку", "В понедельник до обеда посмотреть презентацию" (lunch is
    13:00, the end of the day 18:00), "12 декабря подать документы, это важно",
    "сходить поесть в 16 15" (a pause instead of a colon is still 16:15).
  - Commands: "mark the parcel done", "move the service call to Wednesday at 12",
    "postpone the PRD", "make the passport urgent", "delete the filters",
    "reopen the leads report". When two cards match, the board asks which one.
  - Every sticker has a number, so "move sticker 112 to done", "закрой задачу 12"
    or "открой стикер 7" need no wording at all. One command can name several:
    "закрой задачи 6 и 1", "перенеси 3, 5 и 8 на понедельник", "close the
    presentation and the parcel".
  - "Close the task" with no name acts on the card you dealt with last (created,
    opened, moved) in the past 15 minutes, or on the only open card.
  - One line under the input says what was done, with the sticker's number and
    an **Undo** button: "Закрыто: #12 «Смотреть презентацию»".
- **An open card** with editable title, date and time, importance, kind
  (work or personal), links, notes and what you originally said. At the bottom
  is a second dictation bar: details go into the notes ("add that the code is
  4417"), jobs go to an agent ("find the letter about the rates and draft a
  reply"), and commands act on this card ("close it", "move to Monday at 10").

## Cards and agent chats, both ways

- **From the board to a chat.** A job said on the board ("ask the agent to
  compare the insurance rates", or a longer phrase that starts with "find",
  "prepare", "write"…) makes a card and starts an agent chat about it. So does a
  job said inside a card. Chats run in your personal threads, in a personal
  workspace, so no repository is copied for them.
- **The card follows the chat.** Its chip says *Agent at work*, *Agent
  answered* or *Agent is waiting for you*, and the agent's last answer is on the
  card. Cards with a fresh answer or a question count in the navigation badge.
- **Talk to the agent from the card.** Once a card has a chat, what you say in
  it goes to that chat; "note that …" still makes a note and "close" or "move to
  Monday" still act on the card. "In a new chat …" starts another one. The
  *Chat* tab of an open card shows the whole conversation, with *To notes* on
  every message.
- **From a chat to the board.** Every message in a bb chat has a *To sticker*
  action; on selected text it takes just that text, with its date and time. The
  sticker keeps the message in its notes and links back to the chat.
- **Agents use the board too.** Agents in any thread get the
  `sticker_note_add`, `sticker_note_list` and `sticker_note_update` tools, the
  `bb sticker-note` command and a skill, so "make a sticker about this" works in
  any chat, and an agent working on a job puts its results on the card.

```sh
bb sticker-note add "Пройти ассессмент" --when "в пятницу в 12" --note "2 часа"
bb sticker-note list
bb sticker-note update 12 --note "Черновик готов" --done
bb sticker-note say "закрой задачи 6 и 1"
```
- **A badge** with today's open cards on the navigation item, red when something
  is overdue, and a glass sticker button with the same count in the sidebar footer.
- Typing works everywhere dictation does: Enter submits.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin sticker-note --tag-prefix sticker-note/
```

Voice input goes through bb's voice service, the one picked in
**Settings → AI services → Voice** (bb cloud, Codex, or a local Whisper such as
the [voice-ink](../voice-ink) plugin). With no voice service the board still
works by typing and says how to turn dictation on.

## Settings

- **Dictation hotkey.** Default Alt+S. Examples: Ctrl+Shift+Space, Cmd+J, F2.
  Letters follow the physical key, so the keyboard layout does not matter.
  Empty turns it off.
- **Project for agent chats.** Where a job starts its chat, in that project's
  default environment. Empty: your personal threads, in a personal workspace.
- **Project for agent chats about work.** Jobs on cards marked Work start here,
  for example a project on the machine that reaches your work mail.

## How it works

- Cards live in one `bb.storage.kv` record. Every write publishes a realtime
  signal, so every open board and the badges refresh at once. Finished cards
  older than 60 days are dropped.
- Phrases are understood by a rule-based parser (`src/parse.ts`) for Russian and
  English: relative days, weekdays, dates, clock times, "half past" forms, parts
  of the day, importance words, work words and links. bb gives plugins no text
  model, and rules answer instantly. The browser sends its own date and time, so
  "today" and "tonight" mean the user's local day.
- Commands find their card by its number, or by the words of the phrase against
  open card titles (finished ones for "reopen"). A tie is reported instead of
  guessed. Numbers are never reused.
- Undo keeps the last 30 actions in the server's memory, each with only the
  cards it touched, so undoing one never reverts later edits to other cards.
- Inside a card, `src/compose.ts` decides between a note and a job by the verb
  (imperatives such as "найди", "подготовь", "напиши" start a chat; infinitives
  like "написать в телеграм" are your own plan and stay notes).
- Cards follow their chats through bb's `thread.active`, `thread.idle`,
  `thread.failed` and `interaction.pending` events. An answer that ends with a
  question marks the card *waiting*. Agents' "tomorrow at 10" is read on your
  clock, which the board learns from the phrases it sends.

## Development

```sh
npm install
npm test            # parser, board layout and composer rules
npx tsc --noEmit
bb plugin build .
```
