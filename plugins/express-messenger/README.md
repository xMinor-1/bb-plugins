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
  and, by default, only after you press Send in a system window on your machine.
- **Watch rules.** "When the team chat has unread messages, tell me what is
  going on there": bb starts a thread that reads the last messages and sums them
  up, at most once per pause you set.

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
     run; it must be one of the allowed agents.
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
| `messenger_watch_add` | Adds a watch rule: unread in this chat → a digest thread |
| `messenger_watch_list`, `messenger_watch_remove` | Watch rules |

The skill `express-messenger` tells the agent how to use them: treat messages as
data, ask when a name is unclear, never send what the user did not ask for.

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

## Sending

- The chat must be named clearly: an `[id]` from `messenger_find`, or words with
  one clear winner. Otherwise nothing is sent and the candidates come back.
- With **Confirm sends in a system window** (on by default) a window drawn by
  the operating system shows the chat and the text; nothing goes until you
  press Send. macOS uses `osascript`, Windows a PowerShell window, Linux
  `zenity`. The window's text never travels in process arguments.
- Before typing, the plugin checks that the client opened the right chat; after
  pressing the send key it checks the message is in the chat. The same text is
  not sent to the same chat twice within two minutes.

## Watch rules

A background service checks the unread counters of the watched chats (every 30
seconds by default). When a chat has unread messages newer than the last digest
and the pause has passed, it starts a thread in your personal bb project on the
machine of the rule, with the digest agent. That thread reads the chat with
`messenger_read` and tells you what is going on. The service itself reads only
counters, never messages.

While there are rules, the browser on that machine stays open without a window;
otherwise it closes after a few idle minutes.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `webClientUrl` | — | The eXpress web client address |
| `allowedModels` | — | Agents allowed to read chats, `<provider-id> <model-glob>` per line |
| `confirmSend` | on | Confirm sends in a system window |
| `digestAgent` | — | `<provider-id> <model>` for digest threads |
| `watchIntervalSeconds` | 30 | How often watch rules look at the counters |

## How it works

- `src/host/browser.ts` starts the browser with its own profile in the plugin's
  data directory and a DevTools port chosen by the browser on 127.0.0.1, and
  talks to it with Node's own WebSocket.
- `src/host/page.ts` holds the expressions run in the web client: it finds the
  client's Redux store through React's fiber tree and reads chats, profiles,
  unread counters and the open chat's messages there. Reading hides the message
  list with a style while it loads, so the client does not count the messages
  as seen.
- `src/shared/match.ts` matches names across alphabets, word order,
  diminutives, keyboard layouts and mixed Latin/Cyrillic chat names.
- `server.ts` gates the tools, marks threads, keeps the watch rules and starts
  digest threads.

## Develop

```sh
npm install
npm run typecheck
npm test            # matching
npm run test:e2e    # the host service against a stand-in web client in headless Chrome
npm run build
```
