Let your agents answer questions from a company HTTP service: each person signs in
once with their own login, and the tools only read.

## What you get

- A sign-in page in the sidebar: login, password, a check button, and errors a person
  can act on, in English or Russian.
- Two agent tools: a guide with the methods you configured, and a read-only call that
  validates every parameter.
- An onboarding step for a build's setup page.

## Configure, don't code

The address, the methods, their parameters and the guide for agents are settings, so
your service's details stay in your own private configuration.

## Guards

- One verb, GET. A method path cannot leave the configured address.
- Only the models you list get the tools, and a thread that read the data cannot move
  to another model.
- The password stays in the OS credential store on the agent's machine. Redirects are
  not followed, and it is sent only to the address it was entered for.
- After a refused password the plugin stops signing in until the person acts, so a
  domain does not lock the account.

These guards are built for mistakes, not for a malicious agent: an agent with a shell
runs as the same user as the password store.
