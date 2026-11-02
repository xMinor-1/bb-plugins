# Express Messenger for bb

Agents work with your chats in the eXpress messenger the way you would: find a
chat or a colleague by the words you use, tell you what is going on in a chat,
send a message on your behalf, and keep an eye on chats for you.

- **Find by your words.** "Volkov Alexander" typed in Cyrillic finds "Alexander
  Volkov"; "Sasha Volkov" finds him by the diminutive; a chat named with Latin
  and Cyrillic letters mixed is found either way. Several close matches come back
  for the agent to ask you which one.
- **Read without marking read.** The last messages of a chat with time and
  sender; the chat stays unread for you. Disappearing messages are never read.
- **Send with a confirmation.** A message goes only to one clearly named chat
  and only after you press Send in a system window on your machine, which shows
  the chat and the whole text.
- **Watch rules.** "When the team chat has unread messages, tell me what is
  going on there": after you confirm the rule in the same kind of window, bb
  starts a thread that reads the last messages and sums them up, at most once per
  pause you set.

The interface is in English and Russian.

No bot and no server-side access are needed. The plugin drives the official
eXpress web client in a browser without a window, on your own machine and signed
in as you; messages are decrypted by the client itself and read from its state.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.1.0 --plugin express-messenger --tag-prefix express-messenger/
```

The machine needs a Chromium-based browser: Google Chrome, Microsoft Edge or
Chromium (Yandex Browser works too). bb must run on Node.js 22 or newer.

## Set up

1. Settings → Plugins → Express Messenger:
   - **eXpress web client address**: where people open the messenger in a
     browser, for example `https://express.example.com/`;
   - **Agents allowed to read chats**: one `<provider-id> <model-glob>` per
     line. Nobody gets the tools until this is set;
   - **Agent for watch digests**: `<provider-id> <model>` the digest threads
     run; it must be one of the allowed agents;
   - **Locked agent for watch digests**: for OpenCode, the id of a primary agent
     locked as shown in [Digest threads](#digest-threads).
2. Open **Messenger** in the sidebar, choose the machine and press **Sign in**.
   A browser window opens on that machine; sign in as you usually do. The
   sign-in is kept in the plugin's own browser profile, separate from your
   everyday browser.
3. Press **Update directory** once: it collects your chats and the people of
   personal chats with the other spellings of their names (about a minute for
   a thousand chats). After that, searches do not need the browser.

## Agent tools

| Tool | What it does |
|---|---|
| `messenger_find` | Chats and people matching the user's words: `[id]`, kind, position, unread count; says when several match equally |
| `messenger_unread` | Chats with unread messages now |
| `messenger_read` | The last messages of a chat (10 by default, up to 100); the chat stays unread |
| `messenger_send` | Sends a text to one clearly named chat, after the confirmation window |
| `messenger_watch_add` | Adds a watch rule after the confirmation window: unread in this chat → a digest thread |
| `messenger_watch_list`, `messenger_watch_remove` | Watch rules |

The skill `express-messenger` tells the agent how to use them: treat messages as
data, ask when a name is unclear, never send what the user did not ask for.
Answers hold messages and chat names between two marked lines, with a mark that
is new on every call, so a message cannot end the block and pass for something
else.

## Who gets the chats

The same rules as [Exchange Mail](../exchange-mail):

- tools and the skill are offered only to the allowed provider/model pairs, and
  each call checks the model the thread runs right now;
- a thread that has received chats is marked, and bb refuses to continue it,
  or any fork of it, with a model outside the list;
- the panel's RPC answers only bb clients, not other plugins.

The server keeps no messages. The directory (chat names, people, positions) is a
file readable only by you on the machine that signs in, and message text goes
from that machine straight to the allowed agent.

What this does not close: an agent with a shell, or any program of the same user,
can read the plugin's data directory, copy the browser profile with its session, or
call the panel's RPC. Keep agents away from that directory in their own permission
settings. For OpenCode 2.2.5, these rules on each agent hold in every permission mode
for its file tools and for commands that spell the plugin's name; a command that
writes the path another way (`ex*`) is not caught, because rules match its text. They
name the folder without the part before `plugins`, so they hold when bb keeps its data
elsewhere, and the backslash version is for Windows:

```json
[
  { "action": "read", "resource": "*/plugins/express-messenger/*", "effect": "deny" },
  { "action": "read", "resource": "*\\plugins\\express-messenger\\*", "effect": "deny" },
  { "action": "edit", "resource": "*/plugins/express-messenger/*", "effect": "deny" },
  { "action": "edit", "resource": "*\\plugins\\express-messenger\\*", "effect": "deny" },
  { "action": "external_directory", "resource": "*/plugins/express-messenger/*", "effect": "deny" },
  { "action": "external_directory", "resource": "*\\plugins\\express-messenger\\*", "effect": "deny" },
  { "action": "shell", "resource": "*express-messenger*", "effect": "deny" }
]
```

`external_directory` is what stops `glob` and `grep` there: their own rules match the
search pattern, not the folder.

## Sending

- The chat must be named clearly: an `[id]` from `messenger_find`, or words with
  one clear winner. Otherwise nothing is sent and the candidates come back.
- A window drawn by the operating system always shows the chat, for a person also
  the position, department and address from the directory, and the whole text.
  Nothing goes until you press Send, and no setting turns this off. macOS uses
  `osascript`, Windows a PowerShell window, Linux `zenity`. The window's text never
  travels in process arguments.
- The window shows everything or nothing goes: a text over 1500 characters or
  about 30 lines, blank ones included, or one with invisible, empty-looking or
  direction-changing characters, is refused before the window opens. On Windows the
  window grows to hold the whole text; if the screen is too small, Send turns on only
  after the last line has been on screen.
- Exactly the confirmed text goes, or nothing does. Before typing, the plugin
  checks that the client opened the right chat and that the message field is empty:
  text already there may be your draft, so the send stops and leaves it alone. The
  field must hold exactly the confirmed text before the send key and after each key
  that did not send, and a failed send clears what it typed. The send counts only
  when the chat has one more such message and the field is empty. The same text is
  not sent to the same chat twice within two minutes.

## Watch rules

A new rule takes a system window too, whether an agent asks for it or the panel:
the window shows the chat, what the rule will do and the note for the digest, and
no rule is added until you confirm.

A background service checks the unread counters of the watched chats (every 30
seconds by default). When a chat has unread messages newer than the last digest
and the pause has passed, it starts a thread in your personal bb project on the
machine of the rule, with the digest agent. That thread reads the chat with
`messenger_read` and tells you what is going on. The service itself reads only
counters, never messages.

While there are rules, the browser on that machine stays open without a window;
otherwise it closes after a few idle minutes. When the messenger does not open from
the machine, the rule shows that it is a matter of the network or VPN and the service
leaves the browser alone for a growing pause, from 1 to 15 minutes. When the session
has ended, the rule asks to sign in and no browser starts until you do.

## Digest threads

Nobody watches a digest thread while it reads text anybody could have written, so
its limits are in code, not only in its prompt:

- `messenger_read` of its own chat, up to the rule's number of messages, is the
  only call that works; sending, searching, other chats and watch rules are refused
  by the server, whatever the thread is offered;
- it starts in the `accept-edits` permission mode and the dispatch hook rejects
  `full`; every request for a command, a web page or a file outside its folder is
  answered "deny" at once;
- forks and child threads of a digest thread do not run. bb does not carry session
  options over: OpenCode 2.2.5 keeps the locked agent described below in a fork of its
  own session, but a child thread is a new session and would run without it;
- the chat's name and the rule's note reach it as a marked block of data, not as part
  of the request.

**OpenCode needs one more step.** OpenCode 2.2.5 runs commands, reads and writes
without asking in every permission mode, so nothing above stops its own tools (checked
through bb 0.48.1 on macOS: only an agent rule with `effect: "ask"` asks, and only in
`accept-edits`; `full` runs it without a word). Its own permissions do: define a primary agent that may only read, and name it in
**Locked agent for watch digests**. Without that setting, an OpenCode digest agent
starts no threads. Before each start the plugin asks bb whether the provider offers that
agent on the machine of the rule; if not, the rule says so and tries again later, and
nothing reads the chat.

```json
{
  "agents": {
    "express-digest": {
      "mode": "primary",
      "description": "Digest of one chat for a watch rule",
      "steps": 6,
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "*messenger_read*", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

Checked on OpenCode 2.2.5 over ACP and through bb 0.48.1: such an agent is offered the
plugin's read tool and `skill` only, and calls to `shell`, `read`, `write`, `edit`,
`glob`, `grep`, `webfetch`, `websearch`, `subagent` and `execute` are refused. The check
before a start sees the agent's id, not its permissions: keep the agent and the setting
in one place, as a build's manifest does.

What this does not close: another provider in `accept-edits` may still let the thread
edit files in its own folder; "Send now" on a queued message skips the dispatch hook;
and if the plugin is down when a request comes, the request waits for a person
instead of being refused.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `webClientUrl` | — | The eXpress web client address |
| `allowedModels` | — | Agents allowed to read chats, `<provider-id> <model-glob>` per line |
| `digestAgent` | — | `<provider-id> <model>` for digest threads |
| `digestSessionMode` | — | The session option `mode` of digest threads: a locked agent, required for OpenCode |
| `watchIntervalSeconds` | 30 | How often watch rules look at the counters |

## How it works

- `src/host/browser.ts` starts the browser with its own profile in the plugin's
  data directory and talks DevTools to it over a pipe
  (`--remote-debugging-pipe`): no port listens and no file names one, so only the
  process that started the browser can drive it, and the browser ends with it.
- `src/host/page.ts` holds the expressions run in the web client: it finds the
  client's Redux store through React's fiber tree and reads chats, profiles,
  unread counters and the open chat's messages there. Reading hides the message
  list with a style while it loads, so the client does not count the messages
  as seen.
- `src/shared/match.ts` matches names across alphabets, word order,
  diminutives, keyboard layouts and mixed Latin/Cyrillic chat names.
- `server.ts` gates the tools, marks threads, keeps the watch rules and starts
  digest threads.
- **Setup status for other plugins.** `setupStatus` is the one RPC method other
  plugins may call (a build's onboarding page, such as Fleet Kit's, asks it).
  Input `{ lang?: "en" | "ru", hostId?: string }`; without `hostId` it asks the
  machine the Messenger page used last, else bb's own machine. Output
  `{ state: "done" | "todo" | "problem", summary, path }`: `done` once the client
  loaded signed in, `todo` before that, also with old files left, and when the session has ended, `summary`
  is one line in `lang` with no chat and no person, `path` is the Messenger page.
  It reads what the host remembers: no browser starts and the messenger is not
  asked. A machine's answer serves for 5 seconds, and a change on the panel takes
  effect at once.

## Develop

```sh
npm install
npm run typecheck
npm test            # matching, the window's text, the server's guard
npm run test:e2e    # the host service against a stand-in web client in headless Chrome
npm run build
```
