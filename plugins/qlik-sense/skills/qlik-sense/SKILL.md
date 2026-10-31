---
name: qlik-sense
description: Answer questions about business numbers from the Qlik Sense reports the user enabled — find the right app and sheet, read tables and charts with filters, and quote the sheet link. Use when the user asks for figures, a report, a KPI, a breakdown, or "what does Qlik say".
---

# Qlik Sense reports

The Qlik Sense plugin gives you read-only access to the Qlik Sense apps the user
ticked in the Qlik Sense panel. Nothing you do changes Qlik: every call opens
its own engine session, clears selections, applies the filters you pass, and
reads freshly calculated data.

## Find the report first

1. Call `qlik_reports`. It lists the enabled apps, the sheets the user
   recommended, what each one is for, and links to open them. Pick the app and
   sheet whose note matches the question.
2. No sheet fits? `qlik_list_sheets` shows every sheet of an enabled app.
3. The app is not enabled? You cannot read it. Ask the user to tick it in the
   bb sidebar → Qlik Sense → Reports, or to paste its link under "Can't find a
   report?" — the panel tells them whether their account can open it and how to
   ask for access.

## Read the numbers

1. `qlik_sheet_objects` — the tables, charts, KPIs and filter panes of a sheet,
   with object ids, dimensions and measures.
2. `qlik_field_values` — the exact values a field holds. Filter values must
   match them; Qlik search strings also work: `"*North*"`,
   `">=01.10.2026<=31.10.2026"`, `">=100"`.
3. `qlik_get_data` — the object's data as a table, with your filters. Charts,
   pivots and KPIs all come back as plain tables.
4. `qlik_query` — a breakdown no sheet shows: fields or master dimensions ×
   master measures or formulas such as `Sum(Sales)`. `qlik_list_fields` lists
   what exists, master measures with their formulas.

## Answering

- Say which app, sheet and object the numbers come from, which filters you
  applied, and give the sheet link so the user can check it in Qlik.
- If the answer warns that Qlik dropped a filter, no data matches that
  combination — say so instead of presenting unfiltered numbers.
- Results are capped at `max_rows` (100 by default, 2000 at most). When the
  answer says more rows exist, narrow the filters or aggregate with
  `qlik_query` rather than paging through raw rows.
- Pass `raw_numbers: true` when you need to calculate with the values.

## When access fails

- "Not available to this agent": the model you run on is not in the user's
  list of models allowed to read Qlik data. Tell the user; do not try to reach
  Qlik another way.
- "Qlik did not accept the login or password": the plugin stops signing in so
  the domain does not lock the account. Ask the user to update the password in
  the Qlik Sense panel.
- "Not set up on this machine": the user has not signed in on the machine this
  thread runs on.
