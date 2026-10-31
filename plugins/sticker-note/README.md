# Sticker Note

A personal sticky-note board inside bb, for your own small tasks rather than
agents' work. Say a task out loud right on the board; it lands as a card with
its date, time, importance and links filled in. Commands work by voice too, so
the board rarely needs the mouse.

The interface is in English and Russian, with a switch in the board's title bar.

## What you get

- **A board page** in bb's navigation with four columns by time: *Today*
  (ordered by the clock, with a red "now" line and overdue times in red),
  *Soon* (the next 7 days), *Later* (further out or no date) and *Done*.
  Important cards carry a folded yellow corner, low-priority ones are dimmed.
  Drag a card to another column to reschedule it; the round check marks it done.
- **Dictation on the board.** Press the microphone, or hold Space anywhere on
  the board, and speak. The phrase is understood at once and its parts are
  highlighted: when, importance, work, links.
  - New tasks: "Tomorrow at 10 call the service about the MOT", "On Thursday renew
    the car insurance sravni.ru", "Someday buy vacuum filters", "Вечером в полвосьмого
    забрать посылку", "12 декабря подать документы, это важно".
  - Commands: "mark the parcel done", "move the service call to Wednesday at 12",
    "postpone the PRD", "make the passport urgent", "delete the filters",
    "reopen the leads report". When two cards match, the board asks which one.
  - Every change shows a toast with **Undo**.
- **An open card** with editable title, date and time, importance, kind
  (work or personal), links, notes and what you originally said. At the bottom
  is a second dictation bar: details go into the notes ("add that the code is
  4417"), requests go to an agent ("ask the agent to compare the prices"). A
  request starts an ordinary bb thread with the card as context, and the card
  links to it.
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

- **Project for agent chats.** Where a request said inside a card starts its
  thread. Empty: a project named *Personal* (or *Личное*) if there is one,
  otherwise the first project.

## How it works

- Cards live in one `bb.storage.kv` record. Every write publishes a realtime
  signal, so every open board and the badges refresh at once. Finished cards
  older than 60 days are dropped.
- Phrases are understood by a rule-based parser (`src/parse.ts`) for Russian and
  English: relative days, weekdays, dates, clock times, "half past" forms, parts
  of the day, importance words, work words and links. bb gives plugins no text
  model, and rules answer instantly. The browser sends its own date and time, so
  "today" and "tonight" mean the user's local day.
- Commands find their card by the words of the phrase against open card titles
  (finished ones for "reopen"). A tie is reported instead of guessed.
- Undo keeps the last 30 board states in the server's memory.
- Inside a card, `src/compose.ts` decides between a note and an agent request
  by the verb: "find", "compare", "prepare", "check", "ask the agent" start a chat.

## Development

```sh
npm install
npm test            # parser, board layout and composer rules
npx tsc --noEmit
bb plugin build .
```
