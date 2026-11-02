---
name: http-data-service
description: Answer questions from the company data service configured for this bb, using data_service_guide and data_service_call. Use when the instructions name a data service and the question is about its data.
---

# Company data service

Two tools read one company HTTP service, signed in as the user. Both are read-only.

1. Call `data_service_guide` before the first question in a thread. It returns the
   rules of this service and its methods with their parameters. Follow those rules.
2. Call `data_service_guide` with a `method` for the full reference of a method:
   what its fields mean and its known limits.
3. Call `data_service_call` with `method` and `params`. It returns the service's JSON
   as is. Fetch fresh data for every new question; do not answer from an earlier answer.

## Sign-in

- Never ask for a login or password in chat, and never repeat one if someone sends it.
  Only the person enters them, on the service's page in the bb sidebar.
- If a call says signing in is needed or paused, tell the user to open that page. Do
  not retry: a refused password can lock the account.

## Rules

- Do not write your own HTTP requests to the service. These tools are the only way in.
- Report errors in plain words and never make up data. An answer the tool says was cut
  at the size limit is incomplete: narrow the request and do not present it as complete.
- Company data stays in this thread. Do not send it to outside services or sites.
