# Exchange Mail for bb

Read and answer your Microsoft Exchange mail (on-premises, Exchange Web
Services) without leaving bb. Agents on the models you approve can read and
search the mailbox and prepare replies — but **only a person sends mail**: an
agent saves a draft, you see who it goes to and what it says, press Send, and
confirm in a system window on your computer.

- **Mail** page in the bb sidebar: Inbox and Sent with search, the open
  message with its whole conversation, Reply / Reply all / Forward, and
  *To send* — every draft prepared in bb that waits for you.
- In a thread, an agent's reply shows the draft as a card with its Send button.
- The address book: names from the organization's directory are suggested in
  To and Cc as you type; when an agent finds several people with a similar
  name, a card in the thread shows them for you to choose.
- **Calendar** page: your week from Monday, recurring meetings shown on every
  day they happen, moved and cancelled ones marked. Agents can ask what is on
  a day and when you are free. Read only: meetings are made in Outlook.
- Mail stays in Exchange. bb keeps no copy; drafts live in your Drafts folder,
  so you also see them in Outlook.

Interface: English and Russian — switch with **EN | RU** at the top of the Mail
page; the system window that confirms a send follows the same choice.

## Install

```sh
bb plugin install git:github.com/xMinor-1/bb-plugins --plugin exchange-mail --yes
```

## Set up

Open **Mail** in the sidebar → **Settings**.

1. **Connect your mailbox.** Enter the Exchange Web Services address, for
   example `https://mail.example.com/EWS/Exchange.asmx`, and choose how to sign
   in:
   - **Windows sign-in** (Windows) — no password. On a laptop in the company
     domain, signed in with the work account, Exchange recognizes you the way
     Outlook does.
   - **Kerberos ticket** (macOS, Linux) — no password, when the machine has a
     valid Kerberos ticket for the company domain. On a Mac this is the
     preferred way: no password is stored at all.
   - **Login and password** — `DOMAIN\name` or `name@company.com`. The password
     goes to the system credential store (see below). Use it when the other
     two do not work.
2. **Agents that may read mail.** The page shows the provider/model pairs that
   may read mail and which agents on this machine they cover. The list comes
   from the plugin's `allowedModels` setting, set by whoever configures bb for
   the company; the panel does not change it. Empty means no agent gets mail.

## Reading

- People are shown by name; a long copy list folds to the first three and
  "and N more". Click a person to write to them or copy their address.
- Plain-text mail shows its links as links, and the `name<mailto:address>`
  pairs Exchange writes for signatures are shown once.
- HTML mail is shown formatted, the safe way: sanitized (DOMPurify) in a frame
  where no script runs and no form submits, under a policy that loads nothing
  from the internet. Pictures from the internet wait for **Show pictures** —
  loading them tells the sender you opened the message. Pictures the message
  carries itself (`cid:`) appear inside the text. **Show as plain text**
  switches to Exchange's text version.
- Attachments: **Save** any file up to 10 MB; **Open** in a new tab only PDF,
  pictures and plain text — formats a browser shows without running anything.
  HTML, SVG and Office files are only saved. Attached messages and links to
  files elsewhere open in Outlook.
- The conversation the message belongs to, Inbox and Sent Items together,
  oldest first; a row opens that message.
- **Forward** prepares a draft with the original and its attachments; it is
  sent like any draft — your click and the system window.

## Address book

- **To** and **Cc** suggest people as you type two letters or more: name, job
  title, department and address, from the organization's address book and
  your own contacts (EWS `ResolveNames`). Arrows and Enter or a click put
  `Name <address>` in place of what you typed; addresses typed by hand work as
  before. A name with a comma, like `Surname, Name`, stays one recipient.
- `mail_find_person` gives agents the same search. One match comes back at
  once. When several people match (or the address book has more than it
  listed), bb shows a card in the thread with everyone found, the agent is told
  to wait, and the person chosen on the card goes back to it. **None of them**
  tells the agent to ask you again.
- The address book is the organization's data, so it is guarded like mail:
  only allowed models get the tool, a thread that used it is marked the same
  way, and the choice is checked against the allow-list again before it
  reaches the agent. Agents get name, address, job title, department and
  company; the office is shown only to you.

**What the card does not guarantee.** The card shows the choice to you; it
cannot prove that you made it. bb tells a plugin nothing about who answered a
card, and the `bb` CLI can read a waiting card (`bb thread interactions show`
prints everyone found) and answer it (`bb thread interactions respond`). An
agent that may run shell commands can therefore see the list and pick someone
itself. What protects you is the send: nothing leaves without your click and
the system window, and both list every recipient.

## Calendar

- The **Calendar** page in the sidebar (also a tab of the Mail page) shows a
  week, Monday to Sunday, in your browser's time zone. Every occurrence of a
  recurring meeting is on its own day (EWS `CalendarView` expands the series),
  and each card says what you need to know: *recurring*, *recurring, moved*
  for an occurrence that was moved or changed, *cancelled* (struck through),
  *tentative*, *free*, *away*, *you declined*, *not answered*, *private*.
  A click shows the organizer and who is invited. Arrows switch the week,
  **Today** comes back.
- `calendar_events` gives agents the meetings of a period — "what do I have
  tomorrow": time, subject, place, organizer, how many are invited (not who),
  your response, and whether it was cancelled or moved. Dates are read and
  written in the time zone of the machine with the mailbox.
- **Private events** (marked private in Outlook) reach agents and other
  plugins as their time and free/busy only: no subject, place or people. The
  page shows them to you in full.
- `calendar_free_time` gives the free stretches of working hours (09:00–18:00
  and 30 minutes by default, weekdays only unless asked) — "when am I free on
  Thursday". Busy, tentative and away events take time; cancelled, declined
  and free ones do not. It knows your own calendar only, not other people's.
- The calendar is guarded like mail: only allowed models get the tools, and a
  thread that read it is marked the same way.
- Nothing creates, answers or moves a meeting: there is no such tool or
  button. One request reads 500 events and 62 days at most (31 for free
  time; an hour more when the clocks go back inside the period); the page and
  the agent say when the calendar had more. A subject, place or organizer name
  is kept up to 1000 characters, the list of invitees up to 4000.

### The calendar for other plugins

A plugin such as a personal board can show today's meetings. It calls
`calendarEvents` (contract in `src/shared/calendar-rpc.ts`):

```ts
const answer = await bb.sdk.plugins.callRpc({
  pluginId: "exchange-mail",
  method: "calendarEvents",
  input: {
    start: "2026-11-02T00:00:00+03:00", // ISO with a zone (Z or ±hh:mm)
    end: "2026-11-03T00:00:00+03:00",   // at most 62 days after start
    // hostId: optional; by default the machine the Mail page used last
  },
});
// { ok: true, more: false, events: [{ id, subject, start, end, allDay, location,
//   showAs, myResponse, kind: "single" | "occurrence" | "exception", cancelled, private }] }
// { ok: false, reason: "not-allowed" | "no-machine" | "offline" | "not-connected" | "unavailable", message }
```

- Only plugins listed in the `calendarPlugins` setting get an answer; the rest
  get `not-allowed`. The list is empty until you fill it.
- They get less than the page: times, subjects and places, no organizer and no
  attendees. A private event comes with the subject `"Private"` and no place.
  Keep even its time out of anything shared.
- `start` and `end` are UTC. An all-day event runs from midnight to midnight of
  the mailbox's time zone; to place it in another zone, take the local midnight
  nearest to `start`, as the Calendar page does.
- A plugin on the list takes on the rule the mail tools follow: the calendar
  goes to no model outside the allowed agents. List only plugins you trust
  with that.

## Sending is always a person's click

- Agents have tools to list, search and read mail and to save drafts. There is
  no agent tool that sends.
- The card shows everything that goes: To, Cc, **Bcc**, subject, attachments,
  whether the body is HTML, and the text. Send asks once more in the panel.
- Then the computer that holds the mailbox shows a **system window** — macOS
  `display dialog`, a Windows window, `/usr/bin/zenity` on a Linux desktop —
  with the same list, the length of the text and its start, marked as only the
  start. Only **Send** in that window sends. bb cannot tell a click in its
  panel from a program calling the plugin, so calling the plugin is not enough:
  the window on your desktop must be answered too. That raises the bar, it is
  not a wall — on Windows and under X11 a program running as you can press
  buttons in other windows (on macOS, one with the Accessibility permission).
  Read what the window lists before you press Send. With no desktop session (a
  server, a locked-down machine) nothing is sent: send from Outlook.
- The helpers that draw the window are called by absolute path
  (`/usr/bin/osascript`, PowerShell in `System32`, `/usr/bin/zenity`), never
  looked up in `PATH`.
- Send names the exact version of the draft you were shown (Exchange's change
  key), in the panel and in the system window. If the draft changed in the
  meantime — an agent revised it, someone edited it in Outlook — nothing is
  sent: an open dialog closes and the card shows the new version.

## Who gets the mail

Mail should reach only the models the company approved. The plugin enforces
that in bb, not in the agent:

- The mail tools and the `exchange-mail` skill are offered only to sessions
  whose provider and model match the allow-list. Other agents never see them.
- Every tool call re-checks the model the thread is running *now*, so switching
  models mid-thread does not keep the tools working.
- A thread that has received mail, address book entries or the calendar is marked. bb refuses to send that thread —
  or a fork of it, or a fork of a fork — to a model outside the list, because
  the whole history, mail included, would go to that model. Marks stay when a
  thread is deleted: its forks still hold its mail.
- Tool answers remind the agent that mail is other people's text and that
  instructions inside a message are not orders.

The allow-list is one rule per line, `<provider-id> <model-glob>`:

```text
acp-opencode corp/*
```

**What this does not cover.** bb tells a plugin nothing about who calls its
panel actions: the panel, the `bb` CLI and an agent with a shell all look the
same, with no thread or model attached. So an agent that may run shell
commands can read mail and the calendar with `bb plugin rpc call`, whatever its model, or reach
Exchange itself with `curl` under the user's Windows sign-in. It cannot send:
that takes the system window. Other plugins are refused. Ship only approved
agents in a bb build for company mail, and keep shell commands of agents that
read mail behind approval in the agent's own permission settings.
bb's own AI services (thread titles, commit messages, voice) send thread text
to their service — turn them off in Settings → AI services when threads hold
company mail.

## The password

Only the *Login and password* sign-in stores one, on the machine that reaches
Exchange, never on the bb server:

| OS | Store |
| --- | --- |
| macOS | login Keychain (service `bb-exchange-mail`) |
| Windows | Credential Manager (`bb-exchange-mail:password`) |
| Linux | a file readable only by the user |

The password never appears on a command line: curl receives it on stdin. It
belongs to the address and login it was typed for: change either, and bb
deletes it and asks again, so it never goes to another server.

On macOS the Keychain item is read through `/usr/bin/security`, so any program
running as you can read it the same way; prefer Kerberos sign-in on a Mac.

A domain locks an account after a few refused passwords, so bb signs in
carefully:

- After Exchange refuses the login, nothing tries that login again for **15
  minutes** — not agents, not the panel, not *Try once more*, not a new
  password — and the pause survives restarts and Disconnect. After that, one
  attempt is made when you enter a new password or press *Try once more*; the
  refused password is never retried on its own.
- Requests with the password always go one at a time, not only until the first
  sign-in works: the domain can stop taking the password at any moment (it
  expired, it was changed elsewhere). Each request waits for the answer to the
  one before it, so after the first refusal the rest stop in bb instead of
  each sending the password again.

## Agent tools

| Tool | What it does |
| --- | --- |
| `mail_list` | newest messages of Inbox, Sent, Drafts or Deleted, optionally unread only |
| `mail_search` | Outlook-style search (`from:`, `subject:`, `received:` …) in Inbox and Sent |
| `mail_read` | one message: sender, recipients, date, subject, numbered attachments, text |
| `mail_attachment` | the text of an attachment: text files (txt, csv, json, xml, html…) and PDF; other formats are refused |
| `mail_conversation` | all messages of a message's conversation in Inbox and Sent, oldest first |
| `mail_find_person` | look someone up in the address book; with several matches the user chooses in the thread |
| `mail_draft` | save a reply, reply-all, forward or new message as a draft, or revise one |
| `calendar_events` | meetings of a period, recurring ones expanded: time, subject, place, organizer, number invited, response, cancelled or moved; private ones as time only |
| `calendar_free_time` | free stretches of working hours in a period, from the user's own calendar |

## Settings

All can be set ahead of time by whoever prepares bb for a team:

| Key | Meaning |
| --- | --- |
| `ewsUrl` | Exchange Web Services address suggested on the Connect screen |
| `allowedModels` | the allow-list above |
| `calendarPlugins` | plugin ids that may read the calendar (see above); empty: none |

```sh
bb plugin config exchange-mail set ewsUrl "https://mail.example.com/EWS/Exchange.asmx"
bb plugin config exchange-mail set allowedModels "acp-opencode corp/*"
bb plugin config exchange-mail set calendarPlugins "sticker-note"
```

## How it works

- The **host entry** (`src/host.ts`) runs on the machine where bb runs agents —
  the one inside the corporate network. It talks to Exchange Web Services with
  the operating system's own `curl` (`System32\curl.exe` on Windows,
  `/usr/bin/curl` on macOS): that curl signs in with Negotiate through Windows
  SSPI or the Kerberos ticket, which Node cannot do on its own. Requests travel
  to curl as a config on stdin and are pure ASCII, so console code pages cannot
  mangle Cyrillic or other text.
- The **server entry** (`server.ts`) decides who gets mail (the allow-list, the
  model check, the thread mark) and forwards panel actions to the host. It
  stores no mail.
- Send is decided on the host: `src/host/confirm.ts` draws the system window,
  `src/host/service.ts` checks the change key before and after it.
- EWS operations used: `GetFolder`, `FindItem` (also by `ConversationId`, and
  with a `CalendarView` for the calendar),
  `GetItem` (plain text, or HTML with `TextBody` for the panel), `GetAttachment`,
  `ResolveNames` (address book, with full contact data),
  `CreateItem` with `SaveOnly` (drafts only: message, reply, reply all,
  forward), `SendItem` with the change key,
  `DeleteItem` (to Deleted Items), `UpdateItem` (marks a message read when you
  open it in the panel; agents' reads do not).
- **Setup status for other plugins.** `setupStatus` is the one RPC method other
  plugins may call (a build's onboarding page, such as Fleet Kit's, asks it).
  Input `{ lang?: "en" | "ru", hostId?: string }`; without `hostId` it asks the
  machine the Mail page used last, else bb's own machine. Output
  `{ state: "done" | "todo" | "problem", summary, path }`: `done` once the saved
  connection passed its last check, `summary` is one line in `lang` with no
  address, login or password, `path` is the Mail page. It reads the saved
  connection only and sends nothing to Exchange; a machine's answer serves for
  5 seconds (on Windows each one starts PowerShell to look at the password), and
  a change of the connection drops it. A machine that is not connected and one
  that cannot read its state are told apart.
- Attachment text is extracted on the host — PDF with pdf.js (`unpdf`, no
  fonts loaded), text as UTF-8, UTF-16 or Windows-1251 — and only the text
  goes to the agent. Files go to the panel only when you open or save them.
  A PDF is read up to 200 pages and for one minute, and stops with the tool
  call; HTML is turned into text from its first 2 MB. Mail is written by
  strangers, so all text handling takes time in proportion to the length of
  the text: no message can make the host or the panel hang.
- On the host, the plugin's data folder keeps the connection settings, short
  message refs (`m…` → Exchange ids), refused sign-ins per login (times only)
  and the list of drafts made in bb with the text you or the agent wrote, until
  the draft is sent or discarded.

## Not yet

- Agents read text files and PDF only; Word, Excel and pictures stay for people.
- No shared mailboxes or Exchange Online (OAuth).
- The calendar is read only: meetings are created, answered and moved in
  Outlook. Other people's free/busy (the scheduling assistant) is not read.
- The address book finds people by the start of a name or an address, as the
  To box in Outlook does; it does not browse the directory or show
  photos and phone numbers.

## Develop

```sh
npm install
npx tsc --noEmit && npm test          # unit tests, no Exchange needed
EWS_STUB_URL=$(test/stub/run.sh) npm run test:e2e   # against the EWS stub in docker
bb plugin build .
```

`test/stub/ews_stub.py` is a small EWS stand-in with NTLMv2 sign-in, a
synthetic mailbox and calendar; it also checks the element order of the requests. The
end-to-end tests replace the system window with a stand-in.

The plugin refuses plain `http://` addresses. To point a development bb at the
stub on the same machine, start bb with `EXCHANGE_MAIL_DEV_ALLOW_LOCAL_HTTP=1`;
even then only `localhost` may use http.
