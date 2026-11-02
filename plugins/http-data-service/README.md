# HTTP Data Service

Gives approved agents read-only tools for one company HTTP service that speaks JSON.
Each person signs in once with their own login and password. The address, the methods
and the guide for agents come from settings, so a build keeps everything about its
service in its own private configuration and this plugin names no service.

## What people see

- A **Data Service** page in the sidebar, titled with the configured service name:
  login, password, **Save and check**, and plain-language errors in English or Russian.
- The address is shown read-only: it comes from settings and nobody types it.
- An onboarding step for a build's setup page: the `setupStatus` RPC answers
  `done`, `todo` or `problem` from the saved state.

## What agents get

| Tool | What it does |
|---|---|
| `data_service_guide` | The configured guide and the method list; with `method`, that method's full reference |
| `data_service_call` | One GET to a configured method with validated parameters; returns the JSON as is |

The skill `http-data-service` tells agents how to use both. The method list also reaches
them through the agent instructions.

Tools are static registrations in bb, while a build's settings arrive after the plugin is
installed. So the methods are not separate tools: one call tool takes the method name, and
only declared methods and parameters pass.

## Settings

| Key | What it is |
|---|---|
| `serviceName` | The name people and agents see |
| `summary` | One line telling agents when to use the service |
| `notice` | Optional note on the sign-in page, for example what the data covers |
| `baseUrl` | The `https://` address method paths are relative to |
| `methods` | JSON list of methods, below |
| `checkMethod` | The method the sign-in check calls: no required parameters; its answer is dropped |
| `guide` | Markdown guide for agents |
| `allowedModels` | One rule per line, `<provider-id> <model-glob>`. Empty means no agent gets the tools |

```json
[
  {
    "name": "items",
    "path": "agent/items",
    "summary": "Items by code",
    "reference": "Long Markdown: what the fields mean and known limits",
    "params": [
      { "name": "code", "type": "string", "required": true, "description": "Item code; keep leading zeros" },
      { "name": "limit", "type": "integer", "min": 1, "max": 500 },
      { "name": "closed", "type": "boolean" },
      { "name": "from", "type": "date" },
      { "name": "tags", "type": "list" }
    ]
  }
]
```

A `path` is relative: letters, digits, `_` and `-` between slashes, so a method cannot point
outside the base address. A `date` is `YYYY-MM-DD`. A `list` is joined with commas, so a value that
contains a comma is refused rather than split in two. A number for a `string` parameter is refused,
because it has already lost its leading zeros.

## How the data is kept safe

- **Read-only.** The code has one verb, GET. A method cannot name another.
- **Only allowed models.** The tools, the skill and the instructions are offered only to pairs
  in `allowedModels`, and each call checks the model of the thread's latest dispatched turn.
- **A thread that touched the data stays on allowed models.** The guide or a call marks the
  thread; the dispatch hook refuses to send it, or any fork down its line, to another model.
- **The password stays on the agent's machine.** macOS Keychain or Windows Credential Manager;
  on other systems a file only the user can read, and the page says so. If the OS store
  refuses, saving fails instead of falling back to a file. The server does not keep it.
- **The password goes to one address.** Redirects are not followed. It is bound to the origin it
  was entered for: when `baseUrl` moves to another origin, the host refuses to save without a new password.
- **A refused password pauses signing in.** Until the service has accepted a password, one request
  at a time tries it and the rest wait. After HTTP 401 nothing signs in again, across restarts, until a
  new password or **Try once more**: a domain locks the account after a few failures.
- **Bounded answers.** An answer is cut at 256 KiB and the agent is told it is incomplete. A non-JSON
  answer, such as a sign-in page with status 200, is an error.
- **The sign-in check returns no data**, only whether it worked or why not.

**These guards are built for mistakes, not for a malicious agent.** An agent with a shell runs as
the same user as the password store and the `bb` command, so it could read the password or call the
service itself. What stops a model outside the list is that it never gets the tools, and a thread
cannot reach it. Do not rely on this plugin to contain an agent you do not trust.

The service decides what each account may see. If it does not limit data per person, agents can
read all of it. Say so in `notice` and in `guide`.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.1.0 --plugin http-data-service --tag-prefix http-data-service/
```

The machine agents run on must trust the service's certificate. With a corporate root certificate,
run bb with `NODE_USE_SYSTEM_CA=1`.

## Develop

```sh
npm test
npx tsc --noEmit
bb plugin build .
```
