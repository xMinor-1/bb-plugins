Masks what your agents send to external models, and shows it in every thread.

## What you get

- **A visible state in each thread.** Above the message box: "Masking" with a
  light: green when requests are masked, amber when off, grey for in-network
  models and agents not covered yet. A tooltip explains the state, with request
  and masked value counts. One switch per thread; it applies to the next request.
- **A live feed.** Click the state to see each model request: time, model,
  masked or not, and what was masked by kind (secrets, keys in code, personal
  data, internal hosts, terms).
- **Fail closed.** With masking on and the proxy not running yet, messages wait
  in the queue with the reason and go out once it runs; nothing leaves unmasked.
- **No address to pick.** Requests go where Claude Code would send them anyway;
  the plugin only puts a local masking proxy in between.

Works with Claude Code. You supply the masking proxy binary (a path or a
download URL with a SHA-256 file); the plugin runs it on a loopback port.
