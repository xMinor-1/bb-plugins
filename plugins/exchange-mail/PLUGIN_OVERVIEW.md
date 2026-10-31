# Exchange Mail

Your Microsoft Exchange mailbox (on-premises, Exchange Web Services) inside bb,
with agents that help answer mail but never send it on their own.

## What you get

- **Mail** in the sidebar: Inbox and Sent with Outlook-style search, the open
  message, Reply and Reply all.
- **To send**: every draft prepared in bb — by you or by an agent — with its
  recipients, subject and text, and a Send button that asks once more.
- **In threads**: an agent that drafted a reply shows it as a card with the
  same Send button.

## Agents read; people send

Agents on the models you approve can list, search and read mail and save
drafts. There is no agent tool that sends. Send names the exact version you
were shown; if an agent or Outlook changed the draft meanwhile, nothing goes
out and you see the new version.

Mail reaches only the provider/model pairs you tick. A thread that has read
mail cannot be continued with a model outside that list, and tool answers
remind the agent that instructions inside a message are not orders.

## Sign-in

- **Windows**: as the signed-in Windows user, no password (domain laptops).
- **macOS / Linux**: a Kerberos ticket, or a login and password.
- A password is kept in the macOS Keychain or Windows Credential Manager and
  never put on a command line. After Exchange refuses it, sign-in pauses until
  you enter it again, so retries cannot lock the account.

The plugin uses the system `curl` for Exchange, so no extra software is needed.
Mail stays in Exchange; drafts are ordinary drafts in your Drafts folder.
