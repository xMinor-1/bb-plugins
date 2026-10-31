# Exchange Mail for bb

Read and answer your Microsoft Exchange mail (on-premises, Exchange Web
Services) without leaving bb. Agents on the models you approve can read and
search the mailbox and prepare replies — but **only a person sends mail**: an
agent saves a draft, you see who it goes to and what it says, and press Send.

- **Mail** page in the bb sidebar: Inbox and Sent with search, the open
  message, Reply / Reply all, and *To send* — every draft prepared in bb that
  waits for you.
- In a thread, an agent's reply shows the draft as a card with its Send button.
- Mail stays in Exchange. bb keeps no copy; drafts live in your Drafts folder,
  so you also see them in Outlook.

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
     valid Kerberos ticket for the company domain.
   - **Login and password** — `DOMAIN\name` or `name@company.com`. The password
     goes to the system credential store (see below).
2. **Agents that may read mail.** Tick the provider/model pairs your company
   approved for its mail. Nothing is ticked at first, so no agent gets mail
   until you choose.

## Sending is always a person's click

- Agents have tools to list, search and read mail and to save drafts. There is
  no agent tool that sends.
- Send shows the recipients, the subject and the text, and asks once more.
- Send names the exact version of the draft you were shown (Exchange's change
  key). If the draft changed in the meantime — an agent revised it, someone
  edited it in Outlook — nothing is sent and the card shows the new version.

## Who gets the mail

Mail should reach only the models the company approved. The plugin enforces
that in bb, not in the agent:

- The mail tools and the `exchange-mail` skill are offered only to sessions
  whose provider and model match the allow-list. Other agents never see them.
- Every tool call re-checks the model the thread is running *now*, so switching
  models mid-thread does not keep the tools working.
- A thread that has received mail is marked. bb refuses to send that thread —
  or a fork of it — to a model outside the list, because the whole history,
  mail included, would go to that model.
- Tool answers remind the agent that mail is other people's text and that
  instructions inside a message are not orders.

The allow-list is one rule per line, `<provider-id> <model-glob>`:

```text
acp-opencode corp/*
```

**What this does not cover.** bb cannot tell a click in its own window from a
program running as the same user: an agent that may run shell commands can
call the plugin's panel actions with `bb plugin rpc call`, or reach Exchange
itself with `curl` under the user's Windows sign-in. Keep shell commands of
agents that read mail behind approval in the agent's own permission settings.
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

The password never appears on a command line: curl receives it on stdin. When
Exchange refuses the password, the plugin stops signing in — for agents and the
panel alike, across restarts — until you enter the password again or press
*Try once more*. Otherwise every agent call would retry a stale password, and
the domain locks the account after a few failures.

## Agent tools

| Tool | What it does |
| --- | --- |
| `mail_list` | newest messages of Inbox, Sent, Drafts or Deleted, optionally unread only |
| `mail_search` | Outlook-style search (`from:`, `subject:`, `received:` …) in Inbox and Sent |
| `mail_read` | one message: sender, recipients, date, subject, attachment names, text |
| `mail_draft` | save a reply, reply-all or new message as a draft, or revise one |

## Settings

Both can be set ahead of time by whoever prepares bb for a team:

| Key | Meaning |
| --- | --- |
| `ewsUrl` | Exchange Web Services address suggested on the Connect screen |
| `allowedModels` | the allow-list above |

```sh
bb plugin config exchange-mail set ewsUrl "https://mail.example.com/EWS/Exchange.asmx"
bb plugin config exchange-mail set allowedModels "acp-opencode corp/*"
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
- EWS operations used: `GetFolder`, `FindItem`, `GetItem` (body as plain text),
  `CreateItem` with `SaveOnly` (drafts only), `SendItem` with the change key,
  `DeleteItem` (to Deleted Items), `UpdateItem` (marks a message read when you
  open it in the panel; agents' reads do not).
- On the host, the plugin's data folder keeps the connection settings, short
  message refs (`m…` → Exchange ids) and the list of drafts made in bb with the
  text you or the agent wrote, until the draft is sent or discarded.

## Not yet

- Attachments are listed but not opened; HTML mail is shown as plain text.
- No shared mailboxes, forwarding, calendar or Exchange Online (OAuth).

## Develop

```sh
npm install
npx tsc --noEmit && npm test          # unit tests, no Exchange needed
EWS_STUB_URL=$(test/stub/run.sh) npm run test:e2e   # against the EWS stub in docker
bb plugin build .
```

`test/stub/ews_stub.py` is a small EWS stand-in with NTLMv2 sign-in and a
synthetic mailbox; it also checks the element order of the requests.
