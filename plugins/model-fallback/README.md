# Model Fallback

When an agent's model hits a rate limit, overloads, returns a server error or stops moving, the thread continues on the
next model of your fallback ladder by itself. The person sees which model took over and why, and can cancel the switch
or return the first model. The plugin only ever switches to models from your allowed list that the thread's machine
actually offers.

The interface is in English and Russian.

## What it reacts to

| Situation | What the plugin does |
| --- | --- |
| The turn fails with a rate limit (429), an overload, a 5xx from the model server or a model timeout | Switches to the next model |
| The model thinks longer than the thinking limit, or writes one answer longer than the answer limit | Stops the turn, switches to the next model |
| A running turn sends no events at all for the silence limit, with nothing open | Stops the turn, switches to the next model |
| A slow tool call, shell command or a pending approval | Nothing: another model would wait for it the same way |
| No connection to the model server (DNS, VPN, connection refused), a refused key, a rejected request | Nothing, and says why above the message box |
| The machine running the thread is offline | Nothing: events stop because of the machine, not the model |
| A model on no ladder, or the last model of its ladder | Nothing; on the last model it says that no fallback is left |

bb's own provider retry repeats a failed turn on the same model for Codex and Claude Code. When it has already queued a
retry, this plugin leaves the turn to it.

OpenCode 2 retries a 429 or an overloaded gateway by itself, honouring `Retry-After`, and keeps the turn open meanwhile
without reporting it to bb. For OpenCode threads such failures therefore show up as silence, and the plugin switches
after the silence limit. The same holds for a gateway that takes a request and never answers: OpenCode drops and repeats
it every few minutes, and the turn never ends on its own.

## What the person sees

- **Countdown.** A row above the message box: `Coder: thinking 7 min without an answer. Continuing on Daily in 0:24`,
  with **Switch now** and **Cancel**. Cancel lets the model keep working; the row then offers **Switch to Daily** for
  as long as the turn runs. A countdown of 0 seconds switches at once.
- **The switch.** The plugin stops a hung turn, sets the thread's model to the next one and sends a message that tells
  the agent why it moved and to check what is already done before going on. A small label above that message says it
  was sent automatically. When the failed request never reached the model, the message carries the request again.
- **After the switch.** The row says `Fallback model Daily instead of Coder: …`, with **Return Coder**. Return sets
  the thread's model and the model picked in the message box back; the next message goes to the first model. Choosing another model in the composer ends the
  fallback too. A click on the row lists the thread's switches and its ladder.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `allowedModels` | empty | One rule per line, `<provider-id> <model-glob>`. Empty: the plugin never switches |
| `ladders` | empty | One ladder per line, `<provider-id> <model> > <model> > <model>` |
| `graceSeconds` | 30 | Countdown before a switch; 0 switches at once |
| `thinkingMinutes` | 7 | A model still thinking after this long counts as hung; 0 turns the check off |
| `answerMinutes` | 6 | A model still writing one answer after this long counts as hung; 0 turns it off |
| `silenceMinutes` | 7 | A running turn with no events for this long counts as hung; 0 turns it off |
| `language` | English | Language of the message the plugin posts into the thread: `English` or `Русский` |

```sh
bb plugin config model-fallback set allowedModels "acp-opencode corp/*"
bb plugin config model-fallback set ladders "acp-opencode corp/coder > corp/daily > corp/fast"
```

A ladder model that the allowed list does not allow is skipped, and so is one the thread's machine does not offer.
`allowedModels` uses the same format as the Qlik Sense plugin's setting, so one value fits both. Model ids are the ones
bb shows for the provider, for OpenCode `<provider>/<model>`.

The default limits come from a history of about a hundred OpenCode threads on company models: a healthy model thought
up to about 4 minutes and answered within 2, while stuck ones stayed silent for 38 minutes and longer.

## How it works

- **Failures.** On bb's `turn.failed` event the plugin reads the failed turn's error events and sorts the failure by
  `errorInfo` and, because OpenCode reports none, by the provider's own words.
- **Hangs.** Every 15 seconds it reads the new events of running threads. Item starts and ends tell it what is open;
  only a reasoning or answer item that stays open, or total silence after the provider took the turn, counts.
- **The switch.** `threads.stop` for a hung turn, `threads.update({ model })` to set the thread's model (bb refuses a
  model outside the provider's catalog), then `threads.send` with the message.
- **State.** Per thread in plugin storage, so a countdown survives a restart. The row above the message box is a thread
  context segment; the label above the message is message metadata.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

`e2e/` holds a full check in a throwaway bb: OpenCode 2.2.5 against a fake gateway with a model that never answers, one
that answers 429 and one that works.

```sh
e2e/run.sh                         # builds and starts the container, installs the plugin
e2e/x.sh 'bash /tmp/scenario.sh'   # hang, cancel, rate limit, a model outside the ladder
```
