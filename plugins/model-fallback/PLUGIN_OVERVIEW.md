# Model Fallback

Keeps agent threads going when their model fails or gets stuck. If a turn hits a rate limit, an overloaded or failing
model server or a model timeout, or the model stops moving (thinking or writing one answer for too long, or total
silence), the thread continues on the next model of a fallback ladder you define.

**What people see.** A row above the message box counts down: `Coder: thinking 7 min without an answer. Continuing on
Daily in 0:24`, with Switch now and Cancel. After the switch the row names the model that took over and why, with
Return to go back to the first model. The message the plugin sends to the agent carries a small label, so nobody takes
it for their own words.

**What it leaves alone.** A slow tool, command or a pending approval; no connection to the model server; a refused
key; an offline machine. Another model would not help there, and the row says why.

**Safe by default.** The plugin only switches to models from your allowed list that the thread's machine offers, and
bb itself refuses a model outside the provider's catalog. With an empty allowed list it never switches.

**Settings.** Allowed models, ladders (`<provider-id> <model> > <model> > <model>`), the countdown, three hang limits
and the language of the message to the agent. Works with any provider whose threads report turn events; made for
OpenCode with company models, where bb's own provider retry does not apply.
