Your Microsoft Exchange mailbox (on-premises, Exchange Web Services) inside bb,
with agents that help answer mail but never send it on their own.

## What you get

- **Mail** in the sidebar: Inbox and Sent with Outlook-style search, the open
  message with its whole conversation, Reply, Reply all and Forward.
- **Readable mail**: people by name, links that work, HTML mail shown
  sanitized in a frame without scripts, pictures from the internet only on
  request, attachments to open or save.
- **To send**: every draft prepared in bb — by you or by an agent — with its
  recipients (Bcc included), subject, attachments, format and text, and a Send
  button.
- **In threads**: an agent that drafted a reply shows it as a card with the
  same Send button.
- **Address book**: To and Cc suggest colleagues by name with job title and
  department. When an agent finds several people with a similar name, it asks
  you to choose in the thread instead of guessing.

## Agents read; people send

Agents on the models you approve can list, search and read mail, read
attachments (text files and PDF) and whole conversations, look people up in
the address book, and save drafts. There is no agent tool that sends. Send is confirmed in a system
window on your computer that lists every recipient, Bcc included, and the
text, and it names the exact version you were shown; if an agent or Outlook
changed the draft meanwhile, nothing goes out and you see the new version.
The window is a second step outside bb, not a guarantee: on Windows and X11
other programs running as you can press buttons, so read it before you send.

Mail reaches only the provider/model pairs on the allow-list your bb setup
provides. A thread that has read mail, and every fork of it, cannot be
continued with a model outside that list, and tool answers remind the agent
that instructions inside a message are not orders.

## Sign-in

- **Windows**: as the signed-in Windows user, no password (domain laptops).
- **macOS / Linux**: a Kerberos ticket, or a login and password.
- A password is kept in the macOS Keychain or Windows Credential Manager, only
  for the address and login it was typed for, and never put on a command line.
  After Exchange refuses it, nothing tries that login again for 15 minutes, so
  retries cannot lock the account.

The plugin uses the system `curl` for Exchange, so no extra software is needed.
Mail stays in Exchange; drafts are ordinary drafts in your Drafts folder.
