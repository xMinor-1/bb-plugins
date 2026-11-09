// The last word before a draft leaves: a window drawn by the operating system
// on this machine, not by bb. bb cannot tell whether a call to send came from
// the panel, the CLI or an agent with a shell, so the panel's own dialog is not
// proof that a person decided. A system window moves the decision out of bb:
// calling the RPC is no longer enough, the button in a window on the person's
// desktop has to be pressed too. That raises the bar; it is not a wall. On
// Windows and under X11 any program of the same user can press buttons in
// other windows, and on macOS one with the Accessibility permission can. So
// the window promises nothing about who presses: it asks the person to check
// what goes.
//
//   macOS    /usr/bin/osascript (JavaScript for Automation) `display dialog`
//   Windows  a WinForms window from Windows PowerShell in System32
//   Linux    /usr/bin/zenity, when a desktop session is present
//
// Every tool is called by its absolute path, never looked up in PATH: a PATH
// the agent's shell can change must not choose the program that answers "Send".
//
// The window's text is mail — recipients, subject, the start of the message —
// so it never travels in process arguments (endpoint security tools log command
// lines): every script reads it from stdin, as ASCII-only source.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BodyFormat, DraftKind, Lang, MailAddress, MeetingAction, MeetingResponse, MeetingScope } from "../../contract.js";

export interface SendSummary {
  readonly kind: DraftKind;
  /** Whose mailbox it goes from: the login, or null for Windows / Kerberos sign-in. */
  readonly mailbox: string | null;
  readonly subject: string;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly bcc: readonly MailAddress[];
  readonly attachments: readonly { name: string; size: number | null }[];
  readonly bodyFormat: BodyFormat;
  /** The text written for the message: what the person reads first. */
  readonly text: string;
  /** Characters of quoted original sent below the text, 0 for none. */
  readonly quotedChars: number;
}

/** A meeting change waiting for the window. Times come written out in this machine's zone. */
export interface MeetingSummary {
  readonly meeting: MeetingAction;
  readonly mailbox: string | null;
  readonly scope: MeetingScope;
  readonly subject: string;
  /** The time it will have (create, update) or has (cancel, respond). */
  readonly when: string;
  readonly location: string | null;
  /** update: what it was, for each field that changes. */
  readonly before?: { readonly subject?: string; readonly when?: string; readonly location?: string | null };
  /** create, update: the new text of the invitation, or null when it stays. */
  readonly body: string | null;
  readonly added: readonly MailAddress[];
  readonly removed: readonly MailAddress[];
  /** update: each list of attendees that changes, as it will be — someone moved from required to optional shows here. */
  readonly lists?: { readonly required?: readonly MailAddress[]; readonly optional?: readonly MailAddress[]; readonly rooms?: readonly MailAddress[] };
  /** Who gets mail: invitations, updates, the cancellation or the answer. */
  readonly notify: readonly MailAddress[];
  readonly response: MeetingResponse | null;
  readonly note: string | null;
}

export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "cancelled" | "timeout" | "unavailable" | "busy"; readonly message: string };

export interface SendConfirmer {
  /** `lang` is the panel's language: the window speaks it. */
  confirm(summary: SendSummary | MeetingSummary, signal?: AbortSignal, lang?: Lang): Promise<ConfirmOutcome>;
}

/** How long the window waits for the person before it counts as Cancel. */
export const CONFIRM_TIMEOUT_S = 240;
export const TEXT_PREVIEW = 700;
export const ZENITY = "/usr/bin/zenity";
const MAX_LISTED = 25;

/** The window's words. The host cannot use the panel's i18n module (it needs React), so they live here. */
const WORDS = {
  en: {
    title: "Exchange Mail: send this message?",
    send: "Send",
    cancel: "Cancel",
    kind: { new: "New message", reply: "Reply", replyAll: "Reply to all", forward: "Forward" } satisfies Record<DraftKind, string>,
    from: (mailbox: string) => ` from ${mailbox}`,
    noRecall: "It cannot be called back.",
    to: "To",
    cc: "Cc",
    bcc: "Bcc",
    nobody: "nobody",
    more: (n: number) => `, and ${n} more`,
    subject: "Subject",
    noSubject: "(no subject)",
    attachments: "Attachments",
    none: "none",
    format: "Format",
    formats: {
      text: "plain text",
      html: "HTML: it goes out with formatting, and anything hidden in the HTML, as Outlook shows it",
      rtf: "rich text (RTF): it goes out with formatting, as Outlook shows it",
      unknown: "unknown: Exchange did not say; it may go out as HTML",
    } satisfies Record<BodyFormat, string>,
    text: (n: number) => `Text (${n} characters)`,
    onlyStart: (shown: number, n: number) => `[Only the start is shown here: ${shown} of ${n} characters. The whole text is in the draft card in bb.]`,
    empty: "(empty)",
    quoted: (n: number) => `…followed by the quoted message (${n} characters).`,
    warning: "Check the recipients and the text. Send this message?",
  },
  ru: {
    title: "Exchange Mail: отправить письмо?",
    send: "Отправить",
    cancel: "Отмена",
    kind: { new: "Новое письмо", reply: "Ответ", replyAll: "Ответ всем", forward: "Пересылка" } satisfies Record<DraftKind, string>,
    from: (mailbox: string) => ` из ящика ${mailbox}`,
    noRecall: "Отозвать его будет нельзя.",
    to: "Кому",
    cc: "Копия",
    bcc: "Скрытая копия",
    nobody: "никому",
    more: (n: number) => ` и ещё ${n}`,
    subject: "Тема",
    noSubject: "(без темы)",
    attachments: "Вложения",
    none: "нет",
    format: "Формат",
    formats: {
      text: "обычный текст",
      html: "HTML: уйдёт с оформлением и всем, что скрыто в HTML, как это показывает Outlook",
      rtf: "форматированный текст (RTF): уйдёт с оформлением, как в Outlook",
      unknown: "неизвестен: Exchange не сообщил; может уйти как HTML",
    } satisfies Record<BodyFormat, string>,
    text: (n: number) => `Текст (символов: ${n})`,
    onlyStart: (shown: number, n: number) => `[Здесь только начало: ${shown} из ${n} символов. Весь текст — в карточке черновика в bb.]`,
    empty: "(пусто)",
    quoted: (n: number) => `…и под ним цитата исходного письма (символов: ${n}).`,
    warning: "Проверьте получателей и текст. Отправить письмо?",
  },
};

/** The meeting window's words. */
const MEETING_WORDS = {
  en: {
    title: {
      create: "Exchange Mail: create this meeting?",
      update: "Exchange Mail: change this meeting?",
      cancel: "Exchange Mail: cancel this meeting?",
      respond: "Exchange Mail: answer this invitation?",
    } satisfies Record<MeetingAction, string>,
    confirm: { create: "Create", update: "Change", cancel: "Cancel meeting", respond: "Answer" } satisfies Record<MeetingAction, string>,
    keep: "Back",
    head: {
      create: "A new meeting in your calendar",
      update: "A change to your meeting",
      cancel: "Cancelling your meeting",
      respond: "Your answer to an invitation",
    } satisfies Record<MeetingAction, string>,
    from: (mailbox: string) => ` (${mailbox})`,
    scope: { single: "", occurrence: "Only this occurrence of the series.", series: "Every occurrence of the series." } satisfies Record<MeetingScope, string>,
    subject: "Subject",
    noSubject: "(no subject)",
    when: "When",
    where: "Where",
    nowhere: "(no place)",
    was: (value: string) => `   was: ${value}`,
    added: "Added",
    removed: "Taken off (they get a cancellation)",
    listNow: { required: "Attendees from now", optional: "Optional attendees from now", rooms: "Rooms from now" },
    nobody: "nobody",
    notify: {
      create: "Invitations go to",
      update: "The update goes to",
      cancel: "The cancellation goes to",
      respond: "The answer goes to",
    } satisfies Record<MeetingAction, string>,
    nobodyNotified: "Nobody gets mail: no one else is on it.",
    response: { accept: "Accept", tentative: "Tentative", decline: "Decline" } satisfies Record<MeetingResponse, string>,
    answer: "Answer",
    note: "Note",
    text: (n: number) => `Text of the invitation (${n} characters)`,
    textKept: "Text of the invitation: stays as it is.",
    onlyStart: (shown: number, n: number) => `[Only the start is shown here: ${shown} of ${n} characters. The whole text is on the card in bb.]`,
    empty: "(empty)",
    more: (n: number) => `, and ${n} more`,
    warning: {
      create: "Check the time and the people. Create the meeting and send the invitations?",
      update: "Check what changes and who is told. Change the meeting?",
      cancel: "It cannot be undone. Cancel the meeting and tell everyone?",
      respond: "Send this answer to the organizer?",
    } satisfies Record<MeetingAction, string>,
  },
  ru: {
    title: {
      create: "Exchange Mail: создать встречу?",
      update: "Exchange Mail: изменить встречу?",
      cancel: "Exchange Mail: отменить встречу?",
      respond: "Exchange Mail: ответить на приглашение?",
    } satisfies Record<MeetingAction, string>,
    confirm: { create: "Создать", update: "Изменить", cancel: "Отменить встречу", respond: "Ответить" } satisfies Record<MeetingAction, string>,
    keep: "Назад",
    head: {
      create: "Новая встреча в вашем календаре",
      update: "Изменение вашей встречи",
      cancel: "Отмена вашей встречи",
      respond: "Ваш ответ на приглашение",
    } satisfies Record<MeetingAction, string>,
    from: (mailbox: string) => ` (${mailbox})`,
    scope: { single: "", occurrence: "Только это повторение серии.", series: "Все повторения серии." } satisfies Record<MeetingScope, string>,
    subject: "Тема",
    noSubject: "(без темы)",
    when: "Когда",
    where: "Где",
    nowhere: "(без места)",
    was: (value: string) => `   было: ${value}`,
    added: "Добавлены",
    removed: "Убраны (им придёт отмена)",
    listNow: { required: "Участники теперь", optional: "Участники по желанию теперь", rooms: "Переговорные теперь" },
    nobody: "никого",
    notify: {
      create: "Приглашения получат",
      update: "Изменение получат",
      cancel: "Отмену получат",
      respond: "Ответ получит",
    } satisfies Record<MeetingAction, string>,
    nobodyNotified: "Писем не будет: на встрече больше никого нет.",
    response: { accept: "Принять", tentative: "Под вопросом", decline: "Отклонить" } satisfies Record<MeetingResponse, string>,
    answer: "Ответ",
    note: "Записка",
    text: (n: number) => `Текст приглашения (символов: ${n})`,
    textKept: "Текст приглашения: без изменений.",
    onlyStart: (shown: number, n: number) => `[Здесь только начало: ${shown} из ${n} символов. Весь текст — на карточке в bb.]`,
    empty: "(пусто)",
    more: (n: number) => ` и ещё ${n}`,
    warning: {
      create: "Проверьте время и участников. Создать встречу и разослать приглашения?",
      update: "Проверьте, что меняется и кому уйдёт письмо. Изменить встречу?",
      cancel: "Вернуть её будет нельзя. Отменить встречу и сообщить всем?",
      respond: "Отправить этот ответ организатору?",
    } satisfies Record<MeetingAction, string>,
  },
};

const address = (a: MailAddress) => (a.name && a.name !== a.email ? (a.email ? `${a.name} <${a.email}>` : a.name) : a.email);

/** The window's text and buttons. Exported for tests: what the person is asked must name everything that goes. */
export function confirmationText(summary: SendSummary | MeetingSummary, lang: Lang = "en"): { title: string; message: string; send: string; cancel: string } {
  if ("meeting" in summary) return meetingText(summary, lang);
  const w = WORDS[lang];
  const listed = (label: string, list: readonly MailAddress[]) =>
    list.length === 0 ? null : `${label} (${list.length}): ${list.slice(0, MAX_LISTED).map(address).join(", ")}${list.length > MAX_LISTED ? w.more(list.length - MAX_LISTED) : ""}`;
  const text = summary.text.trim();
  const cut = text.length > TEXT_PREVIEW;
  const start = cut ? text.slice(0, TEXT_PREVIEW).trimEnd() : text;
  const preview = cut ? `${start}…` : text;
  const lines = [
    `${w.kind[summary.kind]}${summary.mailbox ? w.from(summary.mailbox) : ""}. ${w.noRecall}`,
    "",
    listed(w.to, summary.to) ?? `${w.to}: ${w.nobody}`,
    listed(w.cc, summary.cc),
    listed(w.bcc, summary.bcc),
    `${w.subject}: ${summary.subject || w.noSubject}`,
    summary.attachments.length
      ? `${w.attachments} (${summary.attachments.length}): ${summary.attachments
          .slice(0, MAX_LISTED)
          .map((a) => a.name)
          .join(", ")}${summary.attachments.length > MAX_LISTED ? ", …" : ""}`
      : `${w.attachments}: ${w.none}`,
    `${w.format}: ${w.formats[summary.bodyFormat]}`,
    "",
    `${w.text(text.length)}:`,
    preview || w.empty,
    cut ? w.onlyStart(start.length, text.length) : null,
    summary.quotedChars > 0 ? `\n${w.quoted(summary.quotedChars)}` : null,
    "",
    w.warning,
  ];
  return { title: w.title, message: lines.filter((line): line is string => line !== null).join("\n"), send: w.send, cancel: w.cancel };
}

/** The meeting window: what the meeting will be, what changes, and everyone who gets mail about it. */
export function meetingText(summary: MeetingSummary, lang: Lang = "en"): { title: string; message: string; send: string; cancel: string } {
  const w = MEETING_WORDS[lang];
  const action = summary.meeting;
  const people = (list: readonly MailAddress[]) => `${list.slice(0, MAX_LISTED).map(address).join(", ")}${list.length > MAX_LISTED ? w.more(list.length - MAX_LISTED) : ""}`;
  const preview = (value: string, label: (n: number) => string) => {
    const text = value.trim();
    const cut = text.length > TEXT_PREVIEW;
    const start = cut ? text.slice(0, TEXT_PREVIEW).trimEnd() : text;
    return [`${label(text.length)}:`, (cut ? `${start}…` : text) || w.empty, cut ? w.onlyStart(start.length, text.length) : null];
  };
  const before = summary.before ?? {};
  const lines: (string | null)[] = [
    `${w.head[action]}${summary.mailbox ? w.from(summary.mailbox) : ""}.`,
    w.scope[summary.scope] || null,
    "",
    `${w.subject}: ${summary.subject || w.noSubject}`,
    before.subject !== undefined ? w.was(before.subject || w.noSubject) : null,
    `${w.when}: ${summary.when}`,
    before.when !== undefined ? w.was(before.when) : null,
    `${w.where}: ${summary.location || w.nowhere}`,
    before.location !== undefined ? w.was(before.location || w.nowhere) : null,
    "",
    summary.response ? `${w.answer}: ${w.response[summary.response]}` : null,
    summary.added.length ? `${w.added} (${summary.added.length}): ${people(summary.added)}` : null,
    summary.removed.length ? `${w.removed} (${summary.removed.length}): ${people(summary.removed)}` : null,
    ...(["required", "optional", "rooms"] as const).map((name) => {
      const now = summary.lists?.[name];
      return now ? `${w.listNow[name]} (${now.length}): ${now.length ? people(now) : w.nobody}` : null;
    }),
    summary.notify.length ? `${w.notify[action]} (${summary.notify.length}): ${people(summary.notify)}` : w.nobodyNotified,
  ];
  if (action === "create" || action === "update") {
    lines.push("");
    if (summary.body === null) lines.push(w.textKept);
    else lines.push(...preview(summary.body, w.text));
  }
  if (summary.note) lines.push("", ...preview(summary.note, (n) => `${w.note} (${n})`));
  lines.push("", w.warning[action]);
  return { title: w.title[action], message: lines.filter((line): line is string => line !== null).join("\n"), send: w.confirm[action], cancel: w.keep };
}

type WindowText = ReturnType<typeof confirmationText>;

/** JSON with everything outside printable ASCII escaped: safe inside any script source read from stdin. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

interface RunOutput {
  code: number | null;
  stdout: string;
  error: NodeJS.ErrnoException | null;
}

function run(command: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<RunOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: false, shell: false, env: env ?? process.env });
    } catch (error) {
      resolve({ code: null, stdout: "", error: error as NodeJS.ErrnoException });
      return;
    }
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: RunOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => child.kill("SIGKILL");
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024) out.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => finish({ code: null, stdout: "", error }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out).toString("utf8").trim(), error: null }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The scripts print `bb-exchange-mail:<answer>`. Looking for the marker, not
 * comparing the whole output, keeps terminal noise a shell may add from
 * turning a Send into a refusal; anything without it counts as no answer.
 */
const ANSWER = /bb-exchange-mail:(send|cancel|timeout|nogui|error)\b/;
export function answerOf(stdout: string): "send" | "cancel" | "timeout" | null {
  const found = ANSWER.exec(stdout)?.[1];
  return found === "send" || found === "cancel" || found === "timeout" ? found : null;
}

const unavailable = (message: string): ConfirmOutcome => ({ ok: false, reason: "unavailable", message });
const cancelled: ConfirmOutcome = { ok: false, reason: "cancelled", message: "You did not confirm sending in the system window. Nothing was sent." };
const timedOut: ConfirmOutcome = { ok: false, reason: "timeout", message: "Nobody answered the system window in time. Nothing was sent." };
const RUN_LIMIT_MS = (CONFIRM_TIMEOUT_S + 30) * 1000;

// ---------------------------------------------------------------------- macOS

/** JXA: Standard Additions `display dialog`, Cancel is the default and the Escape button. */
export function macScript(text: WindowText): string {
  return [
    "var app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    `var data = ${asciiJson(text)};`,
    "var answer;",
    "try { app.activate(); } catch (e) {}",
    "try {",
    `  var r = app.displayDialog(data.message, { withTitle: data.title, buttons: [data.cancel, data.send], defaultButton: data.cancel, cancelButton: data.cancel, withIcon: "caution", givingUpAfter: ${CONFIRM_TIMEOUT_S} });`,
    '  answer = r.gaveUp ? "timeout" : r.buttonReturned === data.send ? "send" : "cancel";',
    "} catch (e) {",
    '  answer = e.errorNumber === -128 ? "cancel" : "error";',
    "}",
    '"bb-exchange-mail:" + answer;',
    "",
  ].join("\n");
}

function macConfirmer(): SendConfirmer {
  return {
    async confirm(summary, signal, lang) {
      const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-"], macScript(confirmationText(summary, lang)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send" && result.code === 0) return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable(
        "bb could not show the confirmation window on this Mac (no desktop session, or the window was blocked), so nothing was sent. Send it from Outlook, or sign in to this Mac's desktop and try again.",
      );
    },
  };
}

// -------------------------------------------------------------------- Windows

/** The WinForms window. Enter means Cancel: sending takes a deliberate click on Send. */
export function windowsScript(text: WindowText): string {
  const data = Buffer.from(JSON.stringify(text), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { [Console]::Out.Write('bb-exchange-mail:nogui'); return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $d.title
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(600, 460)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.WordWrap = $true
  $box.Text = ($d.message -split "\r?\n") -join [Environment]::NewLine
  $box.SetBounds(12, 12, 576, 390)
  $send = New-Object System.Windows.Forms.Button
  $send.Text = $d.send
  $send.SetBounds(412, 414, 85, 32)
  $send.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = $d.cancel
  $cancel.SetBounds(503, 414, 85, 32)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.AddRange(@($box, $send, $cancel))
  $form.AcceptButton = $cancel
  $form.CancelButton = $cancel
  $form.add_Shown({ $form.Activate(); [void]$cancel.Focus() })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = ${CONFIRM_TIMEOUT_S * 1000}
  $timer.add_Tick({ $timer.Stop(); $form.Tag = 'timeout'; $form.Close() })
  $timer.Start()
  $result = $form.ShowDialog()
  $timer.Stop()
  if ($form.Tag -eq 'timeout') { [Console]::Out.Write('bb-exchange-mail:timeout') }
  elseif ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('bb-exchange-mail:send') }
  else { [Console]::Out.Write('bb-exchange-mail:cancel') }
} catch {
  [Console]::Out.Write('bb-exchange-mail:error')
}
`;
  // One line on stdin: PowerShell reads `-Command -` line by line, so the
  // script travels encoded and is parsed whole.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n`;
}

function windowsConfirmer(): SendConfirmer {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    async confirm(summary, signal, lang) {
      const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], windowsScript(confirmationText(summary, lang)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send") return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable(
        "bb could not show the confirmation window on this computer (no desktop session, or PowerShell is blocked by a company policy), so nothing was sent. Send it from Outlook instead.",
      );
    },
  };
}

// ---------------------------------------------------------------------- Linux

function linuxConfirmer(env: NodeJS.ProcessEnv): SendConfirmer {
  return {
    async confirm(summary, signal, lang) {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
        return unavailable("This machine has no desktop session to show the confirmation window, so nothing was sent. Send it from Outlook instead.");
      }
      const text = confirmationText(summary, lang);
      // --text-info reads the text from stdin; only the fixed title and button labels are arguments.
      const result = await run(
        ZENITY,
        ["--text-info", `--title=${text.title}`, `--ok-label=${text.send}`, `--cancel-label=${text.cancel}`, "--width=600", "--height=480", `--timeout=${CONFIRM_TIMEOUT_S}`],
        `${text.message}\n`,
        RUN_LIMIT_MS,
        signal,
        env,
      );
      if (result.error) return unavailable(`${ZENITY} is not installed, so bb cannot ask in a system window and nothing was sent. Send it from Outlook instead.`);
      if (result.code === 0) return { ok: true };
      if (result.code === 1) return cancelled;
      if (result.code === 5) return timedOut;
      return unavailable("The confirmation window did not open, so nothing was sent.");
    },
  };
}

export function systemConfirmer(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SendConfirmer {
  if (platform === "darwin") return macConfirmer();
  if (platform === "win32") return windowsConfirmer();
  return linuxConfirmer(env);
}

/** One window at a time: a burst of send calls cannot stack windows for the person to click through. */
export function oneAtATime(inner: SendConfirmer): SendConfirmer {
  let open = false;
  return {
    async confirm(summary, signal, lang) {
      if (open) return { ok: false, reason: "busy", message: "Another confirmation is waiting in a system window. Answer it first." };
      open = true;
      try {
        return await inner.confirm(summary, signal, lang);
      } finally {
        open = false;
      }
    },
  };
}
